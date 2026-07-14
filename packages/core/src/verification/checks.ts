import { invariant } from "./builders";
import type { EvidenceCtx, EvidenceCheck } from "./types";
import { makeDeliverabilityCheck } from "./deliverability";
import { makeQbReconcileCheck, makeStripeMatchCheck } from "./reconcile";
import { REQUIRED_CLAUSES } from "../contract-compliance";
import { isEndorsementIdle } from "../endorsement";
import { LEAD_SOURCE_VALUES } from "../lead-sources";

// Recognized lead.source values, derived from the shared enum const so the
// evidence check can never drift from the zod schema / migration mapping.
// Enum members are static, controlled strings — safe to interpolate.
const leadSourceValuesInList = LEAD_SOURCE_VALUES.map((v) => `'${v}'`).join(",");

// Slice 5: a scored lead whose property carries a KNOWN roof-replacement date must
// cite that effective age in its rationale — i.e. score_features.reasons contains a
// "replaced <year>" entry (see lead-scoring.ts). A lead scored off build-year age
// instead (no "replaced" citation) is the violation. Shared verbatim by the named
// lead.effective_age check and the task-19 lead.score sweep (aliases are controlled).
const effectiveAgeUncited = (l: string, p: string) =>
  `${p}.last_roof_replacement_at is not null
     and ${l}.score is not null
     and coalesce((
       select bool_or(e.txt ilike '%replaced%')
         from jsonb_array_elements_text(
           case when jsonb_typeof(${l}.score_features->'reasons') = 'array'
                then ${l}.score_features->'reasons' else '[]'::jsonb end
         ) as e(txt)), false) = false`;

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

  // Every lead older than 1h carries a score + rationale (the scoring agent ran),
  // AND — when its property has a known replacement date — the rationale cites the
  // effective age (slice 5, enforced here under the scoring task since the registry
  // has no distinct roof-age task; see effectiveAgeUncited + lead.effective_age).
  "lead.score": invariant(
    "lead.score",
    `select id
       from lead
      where tenant_id = $1
        and created_at < now() - interval '1 hour'
        and status in ('new','contacted','qualified','booked')
        and (score is null or score_reason is null)
      union
     select l.id
       from lead l
       join property p on p.id = l.property_id and p.tenant_id = l.tenant_id
      where l.tenant_id = $1
        and l.created_at < now() - interval '1 hour'
        and l.status in ('new','contacted','qualified','booked')
        and ${effectiveAgeUncited("l", "p")}`,
    { toRef: (r) => ({ type: "lead", ref: String(r.id) }) },
  ),

  // Named effective-age invariant (slice 5): a scored lead whose property has a
  // replacement date must cite it in its rationale. Its assertion is ALSO enforced
  // in prod via lead.score above (task 19); this standalone key is the red-path
  // target and keeps the scoring-quality guard independently testable/reusable.
  "lead.effective_age": invariant(
    "lead.effective_age",
    `select l.id
       from lead l
       join property p on p.id = l.property_id and p.tenant_id = l.tenant_id
      where l.tenant_id = $1
        and l.created_at < now() - interval '1 hour'
        and l.status in ('new','contacted','qualified','booked')
        and ${effectiveAgeUncited("l", "p")}`,
    { toRef: (r) => ({ type: "lead", ref: String(r.id) }) },
  ),

  // Every lead carries a recognized source. Machine-originated leads (web, inbound_call,
  // canvass, direct_mail) are always stamped by their creation path, so they're never a
  // violation here — this catches manual entry that skipped the taxonomy (null) or a
  // stale/legacy source string that predates the enum.
  "lead.source_taxonomy": invariant(
    "lead.source_taxonomy",
    `select l.id
       from lead l
      where l.tenant_id = $1
        and (
          l.source is null
          or l.source not in (${leadSourceValuesInList})
        )`,
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

  // Every stored canvass contract becomes a WON job within 15 minutes of signing. A stored
  // contract document (kind='contract', canvass r2Key) older than 15m whose lead is not won
  // or has no job is a signed contract that silently failed to become a job — lost revenue.
  // Surfaced here and paged via break-glass (BREAK_GLASS_ON_FAIL_CHECK_KEYS).
  "canvass.contract_to_job": invariant(
    "canvass.contract_to_job",
    `select d.id
       from document d
       join lead l on l.id = d.lead_id and l.tenant_id = d.tenant_id
      where d.tenant_id = $1
        and d.kind = 'contract'
        and d.r2_key like '%/canvass/contract-%'
        and d.created_at < now() - interval '15 minutes'
        and (
          l.status <> 'won'
          or not exists (select 1 from job j where j.lead_id = l.id and j.tenant_id = l.tenant_id)
        )`,
    { toRef: (r) => ({ type: "document", ref: String(r.id) }) },
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

  // Estimate Experience slice 7: every sent estimate has a live tokenized
  // homeowner page (the link mints at the send chokepoint — a sent estimate
  // without one means a path bypassed it). PDF parity joins this check when
  // the PDF fallback ships.
  "estimate.page": invariant(
    "estimate.page",
    `select e.id
       from estimate e
      where e.tenant_id = $1
        and e.status in ('sent', 'accepted')
        and not exists (
          select 1 from booking_link bl
           where bl.tenant_id = e.tenant_id
             and bl.kind = 'estimate'
             and split_part(bl.token, '.', 1) = e.id::text
        )`,
    { toRef: (r) => ({ type: "estimate", ref: String(r.id) }) },
  ),

  // Estimate Experience slice 7: zero acceptances at expired prices — the
  // accept flow refuses past validity, so an accepted-after-expiry row means
  // something bypassed it.
  "estimate.validity": invariant(
    "estimate.validity",
    `select e.id
       from estimate e
       join tenant t on t.id = e.tenant_id
      where e.tenant_id = $1
        and e.accepted_at is not null
        and e.sent_at is not null
        and e.accepted_at > e.sent_at
          + (coalesce((t.settings->'estimate'->>'validityDays')::int, 30) * interval '1 day')`,
    { toRef: (r) => ({ type: "estimate", ref: String(r.id) }) },
  ),

  // Estimate Experience slice 1: no SENT estimate carries an unresolved
  // margin-floor violation in its tier snapshot. Violations are allowed on
  // drafts (they card for the owner) — sending one means it slipped the gate.
  "estimate.margin_floor": invariant(
    "estimate.margin_floor",
    `select id
       from estimate
      where tenant_id = $1
        and status in ('sent', 'accepted')
        and tiers is not null
        and exists (
          select 1 from jsonb_array_elements(tiers) t
           where jsonb_array_length(t->'marginFloorViolations') > 0
        )`,
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

  // A job's stage must be backed by that stage's own evidence. Flags any job declared past
  // what its evidence supports (e.g. 'inspected' with no completed inspection appt and no
  // photo) — catches write-path bypasses. Unbound, like exceptions.roof_type.
  "job.stage_evidence": invariant(
    "job.stage_evidence",
    `select j.id
       from job j
      where j.tenant_id = $1
        and (
          (j.stage = 'inspected' and not (
             exists (select 1 from appointment a where a.tenant_id = j.tenant_id and (a.job_id = j.id or a.lead_id = j.lead_id) and a.type = 'inspection' and a.status = 'done')
             or exists (select 1 from document d where d.tenant_id = j.tenant_id and (d.job_id = j.id or d.lead_id = j.lead_id) and d.kind = 'photo')))
          or (j.stage = 'estimate' and not exists (select 1 from estimate e where e.tenant_id = j.tenant_id and (e.job_id = j.id or e.lead_id = j.lead_id)))
          or (j.stage = 'approved' and not (
             exists (select 1 from estimate e where e.tenant_id = j.tenant_id and (e.job_id = j.id or e.lead_id = j.lead_id) and e.status = 'accepted')
             or exists (select 1 from document d where d.tenant_id = j.tenant_id and (d.job_id = j.id or d.lead_id = j.lead_id) and d.kind = 'contract')))
          or (j.stage = 'production' and not (
             exists (select 1 from appointment a where a.tenant_id = j.tenant_id and a.job_id = j.id and a.type = 'crew' and a.status = 'scheduled')
             or exists (select 1 from material_order m where m.tenant_id = j.tenant_id and m.job_id = j.id and m.status in ('ordered','delivered'))))
          or (j.stage = 'billing' and not exists (select 1 from invoice i where i.tenant_id = j.tenant_id and i.job_id = j.id))
        )`,
    { toRef: (r) => ({ type: "job", ref: String(r.id) }) },
  ),

  // A job ledger must contain ONLY per_job tasks. Any job_task pointing at a
  // task whose registry scope != 'per_job' is a scope-integrity violation
  // (a tenant/lead-scoped task wrongly instantiated on a job). Unbound —
  // this is a structural guard, not a per-task evidence check.
  "job.scope_integrity": invariant(
    "job.scope_integrity",
    `select jt.id
       from job_task jt
       join task_registry tr on tr.id = jt.task_id
      where jt.tenant_id = $1 and tr.scope <> 'per_job'`,
    { toRef: (r) => ({ type: "job_task", ref: String(r.id) }) },
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
  // Activity-feed attribution guard: every agent_run that COULD name a customer should
  // (jobId or leadId set). Flags rows with neither, EXCEPT the genuinely tenant-level
  // writers below — actions with no single customer (a digest, a sweep, a monthly
  // calibration, a break-glass page). Attributable-but-unattributed writers are a real
  // bug to backfill, not to allowlist — see checks.test.ts / task-10 report for the
  // allowlist rationale.
  "activity.attribution": invariant(
    "activity.attribution",
    `select id from agent_run
       where tenant_id = $1 and started_at >= $2 and started_at < $3
         and job_id is null and lead_id is null
         and task_key not in (
           'ops.digest','ops.health_sweep','lead.calibration',
           'ops.break_glass','lead.rescore.upgraded'
         )`,
    {
      params: (ctx) => [ctx.tenantId, ctx.window.start, ctx.window.end],
      toRef: (r) => ({ type: "agent_run", ref: String(r.id) }),
    },
  ),

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

  // ── Batch 3: the bulk evidence pass (2026-07-14) — shipped program queries
  // (Roof Record, Production Pulse, Customer for Life) re-expressed as sweep
  // invariants. Each mirrors its lifecycle twin in packages/db/src/lifecycle
  // (named in the comment) — keep them in step.

  // listUnsupportedActionZones (inspection-findings.ts): the anti-scare
  // invariant — a zone graded ACTION must carry a photo-backed confirmed finding.
  "roof_record.no_unsupported_action": invariant(
    "roof_record.no_unsupported_action",
    `select z.id from inspection_zone z
       where z.tenant_id = $1 and z.grade = 'action'
         and not exists (
           select 1 from inspection_finding f
           where f.inspection_zone_id = z.id
             and f.confirmed_at is not null
             and jsonb_array_length(f.photo_ids) > 0
         )`,
    { toRef: (r) => ({ type: "inspection_zone", ref: String(r.id) }) },
  ),

  // baselineCoverageGaps (inspection-baseline.ts): every published INITIAL
  // Record sets its property's permanent baseline — a null one is a missed hook.
  "roof_record.baseline_coverage": invariant(
    "roof_record.baseline_coverage",
    `select i.id from inspection i
       join property p on p.id = i.property_id
      where i.tenant_id = $1 and i.status = 'published' and i.kind = 'initial'
        and p.baseline_inspection_id is null`,
    { toRef: (r) => ({ type: "inspection", ref: String(r.id) }) },
  ),

  // unlinkedReinspections (storm-reinspect.ts): a post-storm inspection is only
  // useful against its baseline — an unlinked one can't prove what changed.
  "inspection.linked_reinspection": invariant(
    "inspection.linked_reinspection",
    `select i.id from inspection i
      where i.tenant_id = $1 and i.kind = 'post_storm' and i.baseline_inspection_id is null`,
    { toRef: (r) => ({ type: "inspection", ref: String(r.id) }) },
  ),

  // Repair-credit cadence (repair-credit-sweep): no credit expires without the
  // 12/24/33mo check-in cadence having run at least once (opt-outs still log).
  "repair.credit_checkin": invariant(
    "repair.credit_checkin",
    `select rc.id from repair_credit rc
      where rc.tenant_id = $1 and rc.status = 'expired'
        and jsonb_array_length(rc.checkin_log) = 0`,
    { toRef: (r) => ({ type: "repair_credit", ref: String(r.id) }) },
  ),

  // phaseEvidenceGaps (production-detectors.ts): a phase is DONE because photos
  // prove it — a done phase with no evidence is a bypassed transition.
  "production.phase_evidence": invariant(
    "production.phase_evidence",
    `select ph.id from production_phase ph
      where ph.tenant_id = $1 and ph.status in ('done','verified')
        and jsonb_array_length(ph.evidence_photo_ids) = 0`,
    { toRef: (r) => ({ type: "production_phase", ref: String(r.id) }) },
  ),

  // hoUpdateGaps (production-updates.ts): every customer-visible DONE phase
  // produced a homeowner update or a logged suppression.
  "production.ho_updates": invariant(
    "production.ho_updates",
    `select ph.id from production_phase ph
      where ph.tenant_id = $1 and ph.status in ('done','verified') and ph.customer_visible
        and not exists (
          select 1 from production_update u
          where u.job_id = ph.job_id and u.kind = 'phase_complete' and u.phase_key = ph.phase_key
        )`,
    { toRef: (r) => ({ type: "production_phase", ref: String(r.id) }) },
  ),

  // deliveryNoticeGaps (production-updates.ts): by the time materials arrive,
  // both delivery notices (3-day + eve-before) exist — sent or logged-suppressed.
  "production.delivery_notice": invariant(
    "production.delivery_notice",
    `select mo.id from material_order mo
      where mo.tenant_id = $1 and mo.status in ('ordered','delivered')
        and mo.needed_by_at is not null and mo.needed_by_at <= now()
        and mo.job_id is not null
        and (
          not exists (select 1 from production_update u where u.job_id = mo.job_id and u.kind = 'delivery_3day')
          or not exists (select 1 from production_update u where u.job_id = mo.job_id and u.kind = 'delivery_eve')
        )`,
    { toRef: (r) => ({ type: "material_order", ref: String(r.id) }) },
  ),

  // eodGaps (crew-eod.ts): a crew day older than the 18h grace must have filed
  // its EOD report. Day keys are tenant-local; the ±1-day candidate set absorbs
  // timezone offsets the same way the lifecycle's generous window does.
  "production.eod": invariant(
    "production.eod",
    `select distinct cc.id from crew_checkin cc
      where cc.tenant_id = $1
        and cc.checked_in_at >= now() - interval '7 days'
        and cc.checked_in_at < now() - interval '18 hours'
        and not exists (
          select 1 from crew_eod_report r
          where r.job_id = cc.job_id
            and r.day_key in (
              to_char(cc.checked_in_at - interval '12 hours', 'YYYY-MM-DD'),
              to_char(cc.checked_in_at, 'YYYY-MM-DD'),
              to_char(cc.checked_in_at + interval '12 hours', 'YYYY-MM-DD')
            )
        )`,
    { toRef: (r) => ({ type: "crew_checkin", ref: String(r.id) }) },
  ),

  // inspectionGateViolations (production-detectors.ts): no municipally-gated
  // phase runs without its PASSED inspection record.
  "production.inspection_gate": invariant(
    "production.inspection_gate",
    `select ph.id from production_phase ph
      where ph.tenant_id = $1 and ph.status in ('in_progress','done','verified')
        and ph.required_inspection_key is not null
        and not exists (
          select 1 from municipal_inspection mi
          where mi.job_id = ph.job_id
            and mi.inspection_key = ph.required_inspection_key
            and mi.status = 'passed'
        )`,
    { toRef: (r) => ({ type: "production_phase", ref: String(r.id) }) },
  ),

  // governorCapViolations (relationship-touch.ts): zero customers exceed the
  // rolling-year touch cap — any hit means a send path bypassed the calendar.
  // CROSS-CUTTING (all relationship programs) — registered but deliberately
  // UNBOUND in CHECK_BINDINGS, same rationale as comms.no_double_send.
  "relationship.governor": invariant(
    "relationship.governor",
    `select rt.customer_id as id from relationship_touch rt
       join tenant t on t.id = rt.tenant_id
      where rt.tenant_id = $1 and rt.sent_at is not null
        and rt.sent_at >= now() - interval '365 days'
      group by rt.customer_id, t.settings
      having count(*) > coalesce((t.settings #>> '{relationship,touchCapPerYear}')::int, 5)`,
    { toRef: (r) => ({ type: "customer", ref: String(r.id) }) },
  ),

  // enrollmentGaps (relationship-enrollment.ts): every completed job enrolls its
  // customer in the standing cadence (demo tenants are exempt — hard-muted).
  "relationship.enrollment": invariant(
    "relationship.enrollment",
    `select j.id from job j
       join tenant t on t.id = j.tenant_id
      where j.tenant_id = $1 and j.stage = 'complete' and not t.demo
        and not exists (select 1 from relationship_enrollment re where re.job_id = j.id)`,
    { toRef: (r) => ({ type: "job", ref: String(r.id) }) },
  ),

  // cadenceSilenceViolations (relationship-enrollment.ts): no enrolled customer
  // goes >18 months with zero sent touches. Fully-opted-out customers are
  // unreachable by choice and dispute-held ones deliberately quiet — not failures.
  "relationship.cadence": invariant(
    "relationship.cadence",
    `select distinct re.customer_id as id from relationship_enrollment re
       join customer c on c.id = re.customer_id
      where re.tenant_id = $1 and re.suppressed_reason is null
        and re.enrolled_at <= now() - interval '548 days'
        and not c.claim_dispute_hold
        and not (c.sms_opt_out and c.email_opt_out and c.mail_opt_out)
        and not exists (
          select 1 from relationship_touch rt
          where rt.customer_id = re.customer_id
            and rt.sent_at >= now() - interval '548 days'
        )`,
    { toRef: (r) => ({ type: "customer", ref: String(r.id) }) },
  ),

  // movePlayGaps (move-play.ts): every CONFIRMED move produced both plays —
  // the Play A touch (any state; a governor refusal is logged suppression) and
  // the Play B warranty-transfer offer.
  "relationship.move_play": invariant(
    "relationship.move_play",
    `select me.id from move_event me
      where me.tenant_id = $1 and me.status = 'confirmed'
        and (
          not exists (
            select 1 from relationship_touch rt
            where rt.customer_id = me.customer_id and rt.source_ref = me.id::text || ':play_a'
          )
          or not exists (select 1 from warranty_transfer wt where wt.move_event_id = me.id)
        )`,
    { toRef: (r) => ({ type: "move_event", ref: String(r.id) }) },
  ),

  // transfersMissingRecord (move-play.ts): a warranty transfer on a baselined
  // property always carries the Roof Record link.
  "relationship.warranty_record": invariant(
    "relationship.warranty_record",
    `select wt.id from warranty_transfer wt
       join property p on p.id = wt.property_id
      where wt.tenant_id = $1 and p.baseline_inspection_id is not null
        and wt.baseline_inspection_id is distinct from p.baseline_inspection_id`,
    { toRef: (r) => ({ type: "warranty_transfer", ref: String(r.id) }) },
  ),
};

export function getCheck(checkKey: string): EvidenceCheck | undefined {
  return evidenceChecks[checkKey];
}
