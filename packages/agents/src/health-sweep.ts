import {
  evidenceChecks, makeDeliverabilityCheck, makeQbReconcileCheck, makeStripeMatchCheck,
  type EvidenceCheck, type EvidenceCtx, type EvidenceResult,
} from "@savvy/core";
import {
  adminDb, adminPool, recomputeTaskHealth, spotVerifyDoneTasks, computeTenantRollup, reconcileTaskExceptions, recomputeFounderMinutes, recordAgentRun, and, eq,
  taskRegistry, tenantTaskConfig, verificationRun, getA2pRegistration, tenant,
} from "@savvy/db";
import { nangoQbo, stripeGateway } from "@savvy/integrations";
import { pageBreakGlass } from "./break-glass";

// Wire the real A2P registration loader. @savvy/core cannot import @savvy/db
// (db → core is the dependency direction), so the real loader is injected here
// where both packages are available. This override runs once at module load time
// before any sweep executes.
evidenceChecks["comms.deliverability"] = makeDeliverabilityCheck((tenantId) =>
  getA2pRegistration(tenantId).then((r) => ({ registered: r.registered })),
);

// Cell 8: inject the real QuickBooks AR / Stripe collected loaders (same reason —
// @savvy/core can't reach @savvy/db or @savvy/integrations). A tenant with no
// connection returns null (→ the check skips); a vendor error throws (→ stale).
evidenceChecks["finance.qb_reconcile"] = makeQbReconcileCheck(async (tenantId) => {
  const [t] = await adminDb.select({ conn: tenant.qboConnectionId }).from(tenant).where(eq(tenant.id, tenantId));
  if (!t?.conn) return null;
  return (await nangoQbo.arBalanceCents({ connectionId: t.conn })).arCents;
});
evidenceChecks["finance.stripe_match"] = makeStripeMatchCheck(async (tenantId, window) => {
  const [t] = await adminDb.select({ acct: tenant.stripeAccountId }).from(tenant).where(eq(tenant.id, tenantId));
  if (!t?.acct) return null;
  return (await stripeGateway.collectedCents({ connectedAccountId: t.acct, since: window.start, until: window.end })).cents;
});

const CHECK_TIMEOUT_MS = 10_000;
const WINDOW_MS = 86_400_000; // the sweep evaluates the last 24h

/**
 * Runs one evidence check fail-soft: any throw OR a >timeout hang becomes
 * `stale` (never a manufactured `fail`) — a flaky invariant or vendor outage
 * must not red a task. Injectable check keeps this unit-testable.
 */
export async function runCheck(check: EvidenceCheck, ctx: EvidenceCtx, timeoutMs = CHECK_TIMEOUT_MS): Promise<EvidenceResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`check timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([check(ctx), timeout]);
  } catch (e) {
    return { status: "stale", details: `check errored: ${(e as Error).message}`, refs: [] };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The per-tenant health sweep (checker, never doer): for every enabled registry
 * task with a bound check, run the check as ADMIN (adminPool injected as the
 * VerificationDb — tenant isolation is enforced by the check's `tenant_id = $1`,
 * not RLS), write a verification_run, and recompute task_health. Records its own
 * agent_run so the scoreboard is also on the scoreboard. Called per due tenant
 * by the task-health-sweep cron.
 */
export async function sweepTenantHealth(tenantId: string, opts: { now?: Date } = {}): Promise<{ checked: number }> {
  const now = opts.now ?? new Date();
  const window = { start: new Date(now.getTime() - WINDOW_MS), end: now };

  const bound = (
    await adminDb
      .select({ id: taskRegistry.id, checkKey: taskRegistry.checkKey, checkParams: taskRegistry.checkParams })
      .from(taskRegistry)
  ).filter((t): t is typeof t & { checkKey: string } => !!t.checkKey);

  const disabled = await adminDb
    .select({ taskId: tenantTaskConfig.taskId })
    .from(tenantTaskConfig)
    .where(and(eq(tenantTaskConfig.tenantId, tenantId), eq(tenantTaskConfig.enabled, false)));
  const disabledSet = new Set(disabled.map((d) => d.taskId));

  let checked = 0;
  for (const t of bound) {
    if (disabledSet.has(t.id)) continue;
    const check = evidenceChecks[t.checkKey];
    if (!check) continue; // bound to a key with no implementation yet — skip

    const result = await runCheck(check, { tenantId, db: adminPool, params: t.checkParams, window });
    await adminDb.insert(verificationRun).values({
      tenantId, taskId: t.id, checkKey: t.checkKey, status: result.status,
      details: { message: result.details }, refs: result.refs,
    });
    // Spot-verify claimed work against this check's independent result BEFORE
    // recompute, so done-but-wrong exceptions feed the health status.
    await spotVerifyDoneTasks(tenantId, t.id, result, { now });
    await recomputeTaskHealth(tenantId, t.id, { now });
    checked++;
  }

  await reconcileTaskExceptions(tenantId, { now });
  // Interrupt the owner NOW for any exception that cleared the break-glass
  // threshold — the one alert that doesn't wait for the digest.
  await pageBreakGlass(tenantId, { now });
  // Recompute founder-minutes (needs resolved_at from reconcile) before the
  // rollup sums them.
  await recomputeFounderMinutes(tenantId, { now });
  await computeTenantRollup(tenantId, { now });
  await recordAgentRun({ tenantId, agent: "orchestrator", taskKey: "ops.health_sweep", status: "ok" });
  return { checked };
}
