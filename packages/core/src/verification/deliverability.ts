import type { EvidenceCheck, EvidenceCtx } from "./types";

export const DELIVERY_RATE_FLOOR = 0.9;
export const SPAM_ERROR_CODE = "30007";

/** Aggregate one window's terminal SMS receipts for a tenant. One row expected. */
const AGG_SQL = `
  select
    count(*) filter (where delivery_status = 'delivered')   as delivered,
    count(*) filter (where delivery_status = 'failed')      as failed,
    count(*) filter (where delivery_status = 'undelivered') as undelivered,
    count(*) filter (where delivery_error_code = '${SPAM_ERROR_CODE}') as spam
  from communication
  where tenant_id = $1 and direction = 'outbound' and channel = 'sms'
    and created_at >= $2 and created_at < $3
    and delivery_status in ('delivered','failed','undelivered')`;

/**
 * Factory so the A2P registration loader is injectable (real loader wired in
 * packages/agents/src/health-sweep.ts; this module stays pure/dependency-free
 * to avoid the @savvy/core → @savvy/db circular dependency).
 */
export function makeDeliverabilityCheck(
  loadRegistration: (tenantId: string) => Promise<{ registered: boolean }>,
): EvidenceCheck {
  return async (ctx: EvidenceCtx) => {
    const reg = await loadRegistration(ctx.tenantId);
    if (!reg.registered) {
      return {
        status: "fail",
        details: "A2P 10DLC not registered — SMS may be silently filtered",
        refs: [],
      };
    }
    const { rows } = await ctx.db.query<Record<string, number>>(AGG_SQL, [
      ctx.tenantId,
      ctx.window.start,
      ctx.window.end,
    ]);
    const r = rows[0] ?? { delivered: 0, failed: 0, undelivered: 0, spam: 0 };
    const delivered = Number(r.delivered);
    const failed = Number(r.failed);
    const undelivered = Number(r.undelivered);
    const spam = Number(r.spam);
    const total = delivered + failed + undelivered;

    if (total === 0) {
      return { status: "skip", details: "no terminal SMS receipts in window", refs: [] };
    }
    if (spam > 0) {
      return {
        status: "fail",
        details: `${spam} message(s) carrier-filtered (error ${SPAM_ERROR_CODE})`,
        refs: [],
      };
    }
    const rate = delivered / total;
    if (rate < DELIVERY_RATE_FLOOR) {
      return {
        status: "fail",
        details: `delivery rate ${(rate * 100).toFixed(1)}% < ${DELIVERY_RATE_FLOOR * 100}% floor`,
        refs: [],
      };
    }
    return {
      status: "pass",
      details: `delivery rate ${(rate * 100).toFixed(1)}% over ${total} sends`,
      refs: [],
    };
  };
}
