import { invariant } from "./builders";
import type { EvidenceCtx, EvidenceCheck } from "./types";

/**
 * Concrete evidence checks, keyed by task_registry.check_key. The registry
 * stores only the key + params; the logic lives here (versioned, typed, tested).
 *
 * This is batch 1 — the invariants that are cleanly derivable from current
 * schema, including permanent guards for bugs observed 2026-07-01
 * (comms double-send, GMT/raw-link message bodies). Reconciliation and
 * sampled-audit bindings (finance.*, estimate.audit, calls.audit) and the
 * remaining invariants land as their upstream seams are wired.
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
};

export function getCheck(checkKey: string): EvidenceCheck | undefined {
  return evidenceChecks[checkKey];
}
