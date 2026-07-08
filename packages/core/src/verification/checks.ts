import { invariant } from "./builders";
import type { EvidenceCtx, EvidenceCheck } from "./types";
import { makeDeliverabilityCheck } from "./deliverability";
import { makeQbReconcileCheck, makeStripeMatchCheck } from "./reconcile";
import { REQUIRED_CLAUSES } from "../contract-compliance";
import { isEndorsementIdle } from "../endorsement";

// A stamped contract template has "drifted" out of compliance if it is no longer
// active, or (for a gated state) it no longer carries that state's required
// clauses. Built from REQUIRED_CLAUSES so the sweep SQL and the pure resolver
// share one source of truth. Keys/values are controlled constants (state codes +
// clause enum strings) — safe to interpolate.
const templateDriftPredicate = (() => {
  const gaps = Object.entries(REQUIRED_CLAUSES).map(
    ([state, clauses]) =>
      `(upper(btrim(ct.state)) = '${state}' and not ct.clauses @> '${JSON.stringify(clauses)}'::jsonb)`,
  );
  return `(ct.status <> 'active'${gaps.length ? ` or ${gaps.join(" or ")}` : ""})`;
})();

// Gated states as a SQL in-list, e.g. ('CO'). Used to flag unstamped signed
// contracts only in jurisdictions that require a compliant template.
const gatedStatesInList = Object.keys(REQUIRED_CLAUSES)
  .map((s) => `'${s}'`)
  .join(",");

/**
 * Concrete evidence checks, keyed by task_registry.check_key. The registry
 * stores only the key + params; the logic lives here (versioned, typed, tested).
 *
 * Batch 1 (below, through exceptions.roof_type) — invariants cleanly derivable
 * from current schema, incl. permanent guards for bugs observed 2026-07-01
 * (comms double-send, GMT/raw-link message bodies).
 *
 * Batch 2 (lead.speed_to_contact .. finance.commissions) — the remaining
 * invariants whose columns exist today. Still deferred (no backing column /
 * external seam / judge model yet): comms.delivery, booking.reminders,
 * email.policy, finance.qb_reconcile, finance.stripe_match (reconciled tier),
 * estimate.audit, calls.audit (sampled_audit tier).
 */

const windowParams = (ctx: EvidenceCtx) => [ctx.tenantId, ctx.window.start, ctx.window.end];

export const evidenceChecks: Record<string, EvidenceCheck> = {
  // No two outbound messages with the same recipient + body + channel within 24h.
  // (communication has no template column, so identical body is the dedupe key.)
  // Permanent guard for the 2026-07-01 drip double-send bug.
  "comms.no_double_send": invariant(
    "comms.no_double_send",
    `select c1.id, c1."to" as recipient
       from communication c1
       join communication c2
         on c2.tenant_id = c1.tenant_id and c2.id <> c1.id
        and c2.direction = 'outbound' and c2.channel = c1.channel
        and c2."to" = c1."to" and c2.body = c1.body
        and c2.created_at between c1.created_at - interval '24 hours' and c1.created_at
      where c1.tenant_id = $1 and c1.direction = 'outbound'
        and c1.created_at >= $2 and c1.created_at < $3
        and c1."to" is not null and c1.body is not null`,
    { params: windowParams, toRef: (r) => ({ type: "communication", ref: String(r.id) }) },
  ),

  // No outbound body leaks a "GMT" timestamp or a very long URL (raw JWT link).
  // Permanent guard for the 2026-07-01 GMT-timestamp and raw-link bugs.
  "comms.body_quality": invariant(
    "comms.body_quality",
    `select id
       from communication
      where tenant_id = $1 and direction = 'outbound'
        and created_at >= $2 and created_at < $3
        and body is not null
        and (body like '%GMT%' or body ~ 'https?://[^[:space:]]{33,}')`,
    { params: windowParams, toRef: (r) => ({ type: "communication", ref: String(r.id) }) },
  ),

  // No two active leads share a normalized phone or a normalized address.
  "lead.dedupe": invariant(
    "lead.dedupe",
    `select l1.id
       from lead l1
       join lead l2
         on l2.tenant_id = l1.tenant_id and l1.id < l2.id
        and l2.status in ('new','contacted','qualified','booked')
       left join customer cu1 on cu1.id = l1.customer_id
       left join customer cu2 on cu2.id = l2.customer_id
       left join property p1 on p1.id = l1.property_id
       left join property p2 on p2.id = l2.property_id
      where l1.tenant_id = $1
        and l1.status in ('new','contacted','qualified','booked')
        and (
          ( nullif(regexp_replace(coalesce(cu1.phone,''), '\\D', '', 'g'), '') is not null
            and regexp_replace(coalesce(cu1.phone,''), '\\D', '', 'g') = regexp_replace(coalesce(cu2.phone,''), '\\D', '', 'g') )
          or
          ( nullif(lower(trim(coalesce(p1.address,''))), '') is not null
            and lower(trim(coalesce(p1.address,''))) = lower(trim(coalesce(p2.address,''))) )
        )`,
    { toRef: (r) => ({ type: "lead", ref: String(r.id) }) },
  ),

  // Every lead older than 1h carries a score + rationale (the scoring agent ran).
  "lead.score": invariant(
    "lead.score",
    `select id
       from lead
      where tenant_id = $1
        and created_at < now() - interval '1 hour'
        and status in ('new','contacted','qualified','booked')
        and (score is null or score_reason is null)`,
    { toRef: (r) => ({ type: "lead", ref: String(r.id) }) },
  ),

  // A lead that produced a job (job.lead_id references it) must be resolved: won (the
  // normal conversion outcome) or lost. Any other status means the conversion left the
  // lead stuck in-pipeline — the bug where convertLeadToJob wrote 'booked', never 'won',
  // so the WON funnel chip read 0 while the job existed.
  "lead.won_on_convert": invariant(
    "lead.won_on_convert",
    `select l.id
       from lead l
       join job j on j.tenant_id = l.tenant_id and j.lead_id = l.id
      where l.tenant_id = $1
        and l.status not in ('won', 'lost')`,
    { toRef: (r) => ({ type: "lead", ref: String(r.id) }) },
  ),

  // Every typed lead document reaches a terminal parse state within 1h (`pending` past 1h
  // is a stall; `parse_failed`/`unparsed_low_confidence` are valid *carded* states).
  // Additionally, a `parsed` typed doc must have a storage object — a parsed row with a
  // null r2_key is an orphan the viewer cannot resolve (no resolvable view URL path).
  "lead.doc_parse": invariant(
    "lead.doc_parse",
    `select id
       from document
      where tenant_id = $1
        and kind in ('insurance_estimate', 'measurement_report')
        and (
          (created_at < now() - interval '1 hour' and parse_status = 'pending')
          or (parse_status = 'parsed' and r2_key is null)
        )`,
    { toRef: (r) => ({ type: "document", ref: String(r.id) }) },
  ),

  // Every lead-stage estimate cites the measurement source it was priced from
  // (ordered|uploaded_report|sketch). A drafted estimate stamps it; a null here means
  // the pricing-inputs citation is missing.
  "estimate.lead_stage": invariant(
    "estimate.lead_stage",
    `select id
       from estimate
      where tenant_id = $1
        and lead_id is not null
        and measurement_id is not null
        and measurement_source is null`,
    { toRef: (r) => ({ type: "estimate", ref: String(r.id) }) },
  ),

  // No post-inspection job sits past SLA (48h in stage) with an unknown roof type.
  // Pairs with #82's roof_type_needed exception vector.
  "exceptions.roof_type": invariant(
    "exceptions.roof_type",
    `select j.id
       from job j
       join property p on p.id = j.property_id
      where j.tenant_id = $1
        and j.stage in ('inspected','estimate','approved','production','closeout','billing')
        and p.roof_type is null
        and j.stage_entered_at < now() - interval '48 hours'`,
    { toRef: (r) => ({ type: "job", ref: String(r.id) }) },
  ),

  // Speed-to-lead: first rep contact within 5m of lead creation. Flags leads
  // created in-window that were never contacted (past a 15m grace) or contacted
  // late. NOTE: business-hours/tenant-TZ refinement is deferred to the sweep
  // (Slice 4); this is the naive wall-clock version.
  "lead.speed_to_contact": invariant(
    "lead.speed_to_contact",
    `select id
       from lead
      where tenant_id = $1
        and status in ('new','contacted','qualified','booked')
        and created_at >= $2 and created_at < $3
        and (
          (first_rep_contact_at is null and created_at < now() - interval '15 minutes')
          or first_rep_contact_at > created_at + interval '5 minutes'
        )`,
    { params: windowParams, toRef: (r) => ({ type: "lead", ref: String(r.id) }) },
  ),

  // Geocoding converged: no lead older than 24h whose property lacks lat/lng AND
  // has no CLOSED geocode attempt. The enrichment_attempt ledger is consulted so
  // a genuinely un-geocodable address (status 'no_data') doesn't red forever —
  // "attempted and closed out" != "never ran".
  "lead.enrich.geocode": invariant(
    "lead.enrich.geocode",
    `select p.id
       from lead l
       join property p on p.id = l.property_id
      where l.tenant_id = $1
        and l.status in ('new','contacted','qualified','booked')
        and l.created_at < now() - interval '24 hours'
        and p.lat is null and p.lng is null
        and not exists (
          select 1 from enrichment_attempt ea
           where ea.tenant_id = l.tenant_id
             and ea.entity_type = 'property' and ea.entity_id = p.id
             and ea.enricher_key = 'geocode' and ea.status in ('filled','no_data')
        )`,
    { toRef: (r) => ({ type: "property", ref: String(r.id) }) },
  ),

  // StormProof enrichment converged: same ledger pattern as geocode. year_built
  // is the representative field the stormproof enricher fills.
  "lead.enrich.stormproof": invariant(
    "lead.enrich.stormproof",
    `select p.id
       from lead l
       join property p on p.id = l.property_id
      where l.tenant_id = $1
        and l.status in ('new','contacted','qualified','booked')
        and l.created_at < now() - interval '24 hours'
        and p.year_built is null
        and not exists (
          select 1 from enrichment_attempt ea
           where ea.tenant_id = l.tenant_id
             and ea.entity_type = 'property' and ea.entity_id = p.id
             and ea.enricher_key = 'property-stormproof' and ea.status in ('filled','no_data')
        )`,
    { toRef: (r) => ({ type: "property", ref: String(r.id) }) },
  ),

  // Dormant-append guard (#83): no customer with an 'appended' (skip-traced)
  // email is actively enrolled in a drip that has an EMAIL step. Appended
  // addresses are transactional-only — never marketing sends.
  "drip.appended_guard": invariant(
    "drip.appended_guard",
    `select de.id
       from drip_enrollment de
       join drip d on d.id = de.drip_id
       join customer cu on cu.id = de.customer_id
      where de.tenant_id = $1
        and de.status = 'active'
        and cu.email_source = 'appended'
        and exists (
          select 1 from jsonb_array_elements(d.steps) s where s->>'channel' = 'email'
        )`,
    { toRef: (r) => ({ type: "drip_enrollment", ref: String(r.id) }) },
  ),

  // Invoice self-consistency: amount_due equals sum(qty * unitAmountCents) over
  // the line items (mirrors computeInvoiceTotal). Passes trivially until invoices
  // exist, then guards the math the moment the finance agent writes real rows.
  "finance.invoice_math": invariant(
    "finance.invoice_math",
    `select i.id
       from invoice i
      where i.tenant_id = $1
        and i.status <> 'void'
        and coalesce(i.amount_due, 0) <> coalesce((
          select sum((li->>'qty')::numeric * (li->>'unitAmountCents')::numeric)
            from jsonb_array_elements(i.line_items) li
        ), 0)`,
    { toRef: (r) => ({ type: "invoice", ref: String(r.id) }) },
  ),

  // Commission self-consistency: amount_cents == round(max(0,basis) * rate / 1e4),
  // rate in basis points (mirrors computeCommission; floor(x+0.5) == Math.round
  // for non-negative x). Guards the accrual math once commissions are written.
  "finance.commissions": invariant(
    "finance.commissions",
    `select id
       from commission
      where tenant_id = $1
        and amount_cents <> floor(greatest(basis_cents, 0)::numeric * rate / 10000 + 0.5)`,
    { toRef: (r) => ({ type: "commission", ref: String(r.id) }) },
  ),

  // Price-guard coverage: every supplier invoice for a job that has a material
  // order must be fully guarded (status = 'guarded' AND every line carrying a
  // matchedItemKey verdict, even if null = "no baseline"). A 5-minute grace
  // avoids flagging an invoice that is still mid-parse/guard. Zero rows = pass.
  "finance.price_guard": invariant(
    "finance.price_guard",
    `select si.id
       from supplier_invoice si
      where si.tenant_id = $1
        and coalesce(si.total_cents, 0) > 0
        and si.updated_at < now() - interval '5 minutes'
        and exists (select 1 from material_order mo where mo.tenant_id = si.tenant_id and mo.job_id = si.job_id)
        and (
          si.status <> 'guarded'
          or exists (
            select 1 from jsonb_array_elements(si.lines) ln where not (ln ? 'matchedItemKey')
          )
        )`,
    { toRef: (r) => ({ type: "supplier_invoice", ref: String(r.id) }) },
  ),

  // Cell 17b SB38 template-version invariant: every SIGNED contract in a gated
  // jurisdiction (CO) must sit on a currently-compliant, versioned template.
  // Flags (a) a sent/accepted CO estimate with no template stamp, and (b) any
  // estimate OR contract document stamped with a template that has since drifted
  // out of compliance (retired, or a required clause removed). Non-windowed — a
  // template retired today makes a months-old contract stale, so it scans the
  // full current set. The send-time gate prevents new unstamped CO contracts;
  // this catches post-signing drift the gate cannot.
  "compliance.contract_template": invariant(
    "compliance.contract_template",
    `select id, kind from (
       select est.id::text as id, 'estimate' as kind
         from estimate est
         join job j on j.id = est.job_id and j.tenant_id = est.tenant_id
         join property p on p.id = j.property_id and p.tenant_id = est.tenant_id
        where est.tenant_id = $1
          and est.status in ('sent','accepted')
          and est.contract_template_id is null
          and upper(btrim(coalesce(p.state, ''))) in (${gatedStatesInList})
       union all
       select est.id::text as id, 'estimate' as kind
         from estimate est
         join contract_template ct on ct.id = est.contract_template_id and ct.tenant_id = est.tenant_id
        where est.tenant_id = $1 and ${templateDriftPredicate}
       union all
       select d.id::text as id, 'document' as kind
         from document d
         join contract_template ct on ct.id = d.contract_template_id and ct.tenant_id = d.tenant_id
        where d.tenant_id = $1 and d.kind = 'contract' and ${templateDriftPredicate}
     ) v`,
    { toRef: (r) => ({ type: String(r.kind), ref: String(r.id) }) },
  ),

  // SMS deliverability monitoring: checks A2P 10DLC registration status and
  // delivery rate over the window. Tenant not registered → break-glass fail
  // (unregistered tenants risk silent SMS filtering). Rate below DELIVERY_RATE_FLOOR
  // or any spam error (30007) → fail. No terminal receipts → skip.
  //
  // NOTE: @savvy/core cannot import @savvy/db (db → core is the dependency
  // direction). The placeholder loader below throws so any evaluation of this
  // check without the real loader injected surfaces as status:"stale" (via
  // runCheck's catch) rather than silently producing a false registered:false
  // result (a fail-dangerous false positive). The health-sweep
  // (packages/agents/src/health-sweep.ts) overrides this entry with the real
  // getA2pRegistration loader before running checks — the production path is
  // unaffected.
  "comms.deliverability": makeDeliverabilityCheck(async () => {
    throw new Error(
      "comms.deliverability registration loader not wired — import @savvy/agents (health-sweep injects the real getA2pRegistration) before running this check",
    );
  }),

  // Cell 8 money reconciliation (reconciled tier — fail-soft to stale). Like
  // comms.deliverability these are PLACEHOLDERS: @savvy/core cannot import
  // @savvy/db or @savvy/integrations, so health-sweep injects the real QBO AR /
  // Stripe loaders before running. Un-injected, the loader throws → the
  // reconciled builder returns `stale` (never a false fail).
  "finance.qb_reconcile": makeQbReconcileCheck(async () => {
    throw new Error("finance.qb_reconcile loader not wired — health-sweep injects the real QuickBooks AR loader");
  }),
  "finance.stripe_match": makeStripeMatchCheck(async () => {
    throw new Error("finance.stripe_match loader not wired — health-sweep injects the real Stripe loader");
  }),

  // Cell 16 mortgage-endorsement chase: no OPEN endorsement (needed/requested)
  // may sit idle more than 5 BUSINESS days. Business-day math is JS-side (weekends
  // skipped), so this is a custom check rather than the SQL invariant() builder.
  // Idle is measured from the last chase touch, or the claim's created_at when
  // never touched. `now` = the sweep window end.
  "claim.endorsement_no_idle": async (ctx) => {
    const { rows } = await ctx.db.query<{ id: string; status: string; last: string | null; created: string | null }>(
      `select id, endorsement_status as status, endorsement_last_action_at as last, created_at as created
         from claim
        where tenant_id = $1 and endorsement_status in ('needed', 'requested')`,
      [ctx.tenantId],
    );
    const now = ctx.window.end;
    const stale = rows.filter((r) =>
      isEndorsementIdle(r.status, r.last ? new Date(r.last) : null, now, 5, r.created ? new Date(r.created) : undefined),
    );
    if (stale.length === 0) return { status: "pass", details: "claim.endorsement_no_idle: no idle endorsements", refs: [] };
    return {
      status: "fail",
      details: `claim.endorsement_no_idle: ${stale.length} endorsement(s) idle > 5 business days`,
      refs: stale.slice(0, 50).map((r) => ({ type: "claim", ref: String(r.id) })),
    };
  },

  // Onboarding-lockout guard (permanent guard for the 2026-07-06 P0). A tenant
  // with real work — ≥1 job OR ≥1 lead — must NOT have a null
  // settings.onboarding.requiredCompletedAt: the (app) layout gate reads that flag
  // and, when null, redirects to /onboarding on EVERY route, locking the customer
  // out of the whole app. A genuinely empty tenant (no jobs/leads) with a null flag
  // is CORRECT (still onboarding) and must pass — so the job/lead EXISTS clause is
  // exactly what separates a locked-out customer from a fresh signup. Per-tenant
  // (tenant_id = $1); the tenant row itself is the violation ref. A gate regression
  // that re-introduces the lockout reds this task and pages via the nightly sweep.
  "onboarding.no_lockout": invariant(
    "onboarding.no_lockout",
    `select t.id
       from tenant t
      where t.id = $1
        and (t.settings #>> '{onboarding,requiredCompletedAt}') is null
        and (
          exists (select 1 from job j where j.tenant_id = t.id)
          or exists (select 1 from lead l where l.tenant_id = t.id)
        )`,
    { toRef: (r) => ({ type: "tenant", ref: String(r.id) }) },
  ),
};

export function getCheck(checkKey: string): EvidenceCheck | undefined {
  return evidenceChecks[checkKey];
}
