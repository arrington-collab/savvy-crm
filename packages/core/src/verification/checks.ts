import { invariant } from "./builders";
import type { EvidenceCtx, EvidenceCheck } from "./types";

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
};

export function getCheck(checkKey: string): EvidenceCheck | undefined {
  return evidenceChecks[checkKey];
}
