import type { EvidenceCheck, EvidenceCtx, EvidenceRef, EvidenceResult } from "./types";

const MAX_REFS = 50; // cap refs so a big violation set doesn't bloat the row

/**
 * Tier `execution`: proves a task *ran* — at least one agent_run with this
 * task_key exists in the window. Absence = fail (it was expected to run).
 */
export function executed(taskKey: string): EvidenceCheck {
  return async ({ tenantId, db, window }) => {
    const { rows } = await db.query<{ id: string }>(
      `select id from agent_run
        where tenant_id = $1 and task_key = $2 and started_at >= $3 and started_at < $4
        order by started_at desc limit 5`,
      [tenantId, taskKey, window.start, window.end],
    );
    if (rows.length === 0) {
      return { status: "fail", details: `no agent_run "${taskKey}" in window`, refs: [] };
    }
    return {
      status: "pass",
      details: `${rows.length} run(s) of "${taskKey}"`,
      refs: rows.map((r) => ({ type: "agent_run", ref: r.id })),
    };
  };
}

/**
 * Tier `invariant`: deterministic SQL that SELECTs violation rows against prod
 * state. Zero rows = pass; any rows = fail (math checks the agent).
 *
 * `opts.params` builds the bind params for the query — default is just the
 * tenant id (`$1`). Window-scoped invariants pass
 * `(ctx) => [ctx.tenantId, ctx.window.start, ctx.window.end]` and reference
 * `$1/$2/$3`. (Postgres rejects extra binds, so params must match the SQL.)
 */
export function invariant(
  name: string,
  sqlText: string,
  opts: {
    params?: (ctx: EvidenceCtx) => unknown[];
    toRef?: (row: Record<string, unknown>) => EvidenceRef;
  } = {},
): EvidenceCheck {
  const buildParams = opts.params ?? ((ctx: EvidenceCtx) => [ctx.tenantId]);
  const toRef =
    opts.toRef ?? ((r: Record<string, unknown>) => ({ type: name, ref: String((r.id as string | number | undefined) ?? "") }));
  return async (ctx) => {
    const { rows } = await ctx.db.query<Record<string, unknown>>(sqlText, buildParams(ctx));
    if (rows.length === 0) return { status: "pass", details: `${name}: no violations`, refs: [] };
    return {
      status: "fail",
      details: `${name}: ${rows.length} violation(s)`,
      refs: rows.slice(0, MAX_REFS).map(toRef),
    };
  };
}

/**
 * Tier `reconciliation`: compare Savvy's state against a third party's ground
 * truth (QuickBooks AR, Stripe payouts). Fail-soft: a vendor error/outage is
 * `stale` (not `fail`) so a flaky API never manufactures a red.
 */
export function reconciled<E>(
  fetchExternal: (ctx: EvidenceCtx) => Promise<E>,
  compare: (external: E, ctx: EvidenceCtx) => Promise<EvidenceResult> | EvidenceResult,
): EvidenceCheck {
  return async (ctx) => {
    let external: E;
    try {
      external = await fetchExternal(ctx);
    } catch (e) {
      return { status: "stale", details: `external fetch failed: ${(e as Error).message}`, refs: [] };
    }
    return compare(external, ctx);
  };
}

export interface AuditSample {
  id: string;
  subject: unknown;
}
export interface AuditVerdict {
  agree: boolean;
  note?: string;
}

/**
 * Tier `sampled_audit`: a *different, cheap* model re-does a random sample and
 * we compare. Runs weekly, cost-capped upstream. Fails when the disagreement
 * rate exceeds `maxDisagreementRate` (default 0 = any disagreement fails).
 * No samples = skip (nothing to audit this window).
 */
export function sampledAudit(
  sampler: (ctx: EvidenceCtx) => Promise<AuditSample[]>,
  judge: (sample: AuditSample, ctx: EvidenceCtx) => Promise<AuditVerdict>,
  opts: { maxDisagreementRate?: number } = {},
): EvidenceCheck {
  const maxRate = opts.maxDisagreementRate ?? 0;
  return async (ctx) => {
    const samples = await sampler(ctx);
    if (samples.length === 0) return { status: "skip", details: "no samples to audit", refs: [] };
    const disagreements: EvidenceRef[] = [];
    for (const s of samples) {
      const v = await judge(s, ctx);
      if (!v.agree) disagreements.push({ type: "audit", ref: s.id, url: v.note });
    }
    const rate = disagreements.length / samples.length;
    if (rate > maxRate) {
      return {
        status: "fail",
        details: `${disagreements.length}/${samples.length} disagreed (rate ${rate.toFixed(2)} > ${maxRate})`,
        refs: disagreements.slice(0, MAX_REFS),
      };
    }
    return { status: "pass", details: `${samples.length} sampled, disagreement rate ${rate.toFixed(2)}`, refs: [] };
  };
}
