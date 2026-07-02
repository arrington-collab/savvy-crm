import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  computeTaskHealth, buildTaskExceptions,
  type TaskHealthInputs, type TaskHealthResult, type EvidenceResult, type TaskException,
} from "@savvy/core";
import { withTenant } from "../tenant";
import { taskRegistry, tenantTaskConfig, taskHealth, verificationRun, jobTask, leadTask, job, tenantOpsRollup } from "../schema/index";

const DAY_MS = 86_400_000;

/**
 * Recomputes and persists (tenant, task) health from current state — the
 * scoreboard's write step, called by the nightly sweep after it has run checks
 * and spot-verified claimed work. Gathers verification history + open ledger
 * exceptions, runs the pure `computeTaskHealth` rules, and upserts task_health.
 * Returns the result so the caller can act on a regression (green -> amber/red).
 */
export async function recomputeTaskHealth(
  tenantId: string,
  taskId: number,
  opts: { now?: Date } = {},
): Promise<TaskHealthResult> {
  const now = opts.now ?? new Date();
  return withTenant(tenantId, async (tx) => {
    const [reg] = await tx
      .select({ defaultMode: taskRegistry.defaultMode, checkKey: taskRegistry.checkKey, slaHours: taskRegistry.slaHours })
      .from(taskRegistry)
      .where(eq(taskRegistry.id, taskId));
    const [cfg] = await tx
      .select({ mode: tenantTaskConfig.mode, enabled: tenantTaskConfig.enabled })
      .from(tenantTaskConfig)
      .where(and(eq(tenantTaskConfig.tenantId, tenantId), eq(tenantTaskConfig.taskId, taskId)));
    const [prior] = await tx
      .select({ status: taskHealth.status, streak: taskHealth.cleanStreakDays })
      .from(taskHealth)
      .where(and(eq(taskHealth.tenantId, tenantId), eq(taskHealth.taskId, taskId)));

    // Verification history, newest first — drives latest status + consecutive fails.
    const runs = await tx
      .select({ status: verificationRun.status, ranAt: verificationRun.ranAt })
      .from(verificationRun)
      .where(and(eq(verificationRun.tenantId, tenantId), eq(verificationRun.taskId, taskId)))
      .orderBy(desc(verificationRun.ranAt))
      .limit(30);

    let consecutiveFails = 0;
    for (const r of runs) {
      if (r.status === "fail") consecutiveFails++;
      else break;
    }
    const lastVerifiedAt = runs.find((r) => r.status === "pass")?.ranAt ?? null;
    const failCount7d = runs.filter((r) => r.status === "fail" && now.getTime() - r.ranAt.getTime() <= 7 * DAY_MS).length;

    // Open exceptions attributed to this task = done ledger rows the sweep flipped
    // to 'exception' (done-but-wrong). Union job + lead ledgers.
    const excJob = await tx
      .select({ updatedAt: jobTask.updatedAt })
      .from(jobTask)
      .where(and(eq(jobTask.tenantId, tenantId), eq(jobTask.taskId, taskId), eq(jobTask.status, "exception")));
    const excLead = await tx
      .select({ updatedAt: leadTask.updatedAt })
      .from(leadTask)
      .where(and(eq(leadTask.tenantId, tenantId), eq(leadTask.taskId, taskId), eq(leadTask.status, "exception")));
    const exceptions = [...excJob, ...excLead];
    const openExceptionPastSla =
      reg?.slaHours != null && exceptions.some((e) => now.getTime() - e.updatedAt.getTime() > reg.slaHours! * 3_600_000);

    const enabled = cfg?.enabled !== false;
    const effectiveMode = cfg?.mode ?? reg?.defaultMode ?? "manual";
    const inputs: TaskHealthInputs = {
      mode: effectiveMode,
      hasCheckKey: !!reg?.checkKey && enabled,
      priorStatus: prior?.status ?? "gray",
      priorStreakDays: prior?.streak ?? 0,
      latestVerification: runs[0]?.status ?? null,
      consecutiveFails,
      doneButWrong: exceptions.length > 0,
      openExceptionCount: exceptions.length,
      openExceptionPastSla,
    };
    const result = computeTaskHealth(inputs);

    // Upsert only the fields this step owns; leave last_executed_at /
    // founder_minutes_30d (set by execution + the founder-minutes instrumentation).
    await tx
      .insert(taskHealth)
      .values({
        tenantId, taskId, status: result.status, effectiveMode,
        cleanStreakDays: result.cleanStreakDays, lastVerifiedAt,
        failCount7d, openExceptionCount: exceptions.length,
      })
      .onConflictDoUpdate({
        target: [taskHealth.tenantId, taskHealth.taskId],
        set: {
          status: result.status, effectiveMode,
          cleanStreakDays: result.cleanStreakDays, lastVerifiedAt,
          failCount7d, openExceptionCount: exceptions.length, updatedAt: sql`now()`,
        },
      });

    return result;
  });
}

/**
 * Spot-verifies the doer's claimed work against the checker's independent result
 * (the highest-value "done-but-wrong" catch). For each `done` ledger row of this
 * task, compares its evidence ref to the check's violation refs:
 *   - check passed        -> every done row is `verified` (invariant holds)
 *   - check failed + ref IS a violation -> `exception` (done-but-wrong)
 *   - check failed + ref not a violation -> `verified`
 *   - stale/skip          -> leave `done` (inconclusive; can't verify this window)
 * `recomputeTaskHealth` then reads the resulting exception rows (-> red). The
 * checker is never the doer: the doer wrote the evidence; the check found the
 * violations independently.
 */
export async function spotVerifyDoneTasks(
  tenantId: string,
  taskId: number,
  check: Pick<EvidenceResult, "status" | "refs">,
  opts: { now?: Date } = {},
): Promise<{ verified: number; exceptions: number }> {
  if (check.status !== "pass" && check.status !== "fail") return { verified: 0, exceptions: 0 };
  const now = opts.now ?? new Date();
  const violations = new Set(check.refs.map((r) => `${r.type}:${r.ref}`));
  const isViolation = (ev: { type: string; ref: string } | null): boolean =>
    check.status === "fail" && ev != null && violations.has(`${ev.type}:${ev.ref}`);

  return withTenant(tenantId, async (tx) => {
    let verified = 0, exceptions = 0;

    const jobRows = await tx
      .select({ id: jobTask.id, evidence: jobTask.evidence })
      .from(jobTask)
      .where(and(eq(jobTask.tenantId, tenantId), eq(jobTask.taskId, taskId), eq(jobTask.status, "done")));
    for (const row of jobRows) {
      if (isViolation(row.evidence)) {
        await tx.update(jobTask).set({ status: "exception", updatedAt: now }).where(eq(jobTask.id, row.id));
        exceptions++;
      } else {
        await tx.update(jobTask).set({ status: "verified", verifiedAt: now, updatedAt: now }).where(eq(jobTask.id, row.id));
        verified++;
      }
    }

    const leadRows = await tx
      .select({ id: leadTask.id, evidence: leadTask.evidence })
      .from(leadTask)
      .where(and(eq(leadTask.tenantId, tenantId), eq(leadTask.taskId, taskId), eq(leadTask.status, "done")));
    for (const row of leadRows) {
      if (isViolation(row.evidence)) {
        await tx.update(leadTask).set({ status: "exception", updatedAt: now }).where(eq(leadTask.id, row.id));
        exceptions++;
      } else {
        await tx.update(leadTask).set({ status: "verified", verifiedAt: now, updatedAt: now }).where(eq(leadTask.id, row.id));
        verified++;
      }
    }

    return { verified, exceptions };
  });
}

/**
 * The tenant's current scoreboard exceptions — computed from state (the #82
 * pattern: no exception table, no marker columns). Every amber/red task is an
 * open exception; recovering to green removes it. Consumed by the digest and
 * the read-only UI. Ranked by severity then founder-minutes (the automation
 * priority queue).
 */
export async function computeTaskExceptions(tenantId: string): Promise<TaskException[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({
        taskId: taskHealth.taskId,
        status: taskHealth.status,
        openExc: taskHealth.openExceptionCount,
        name: taskRegistry.name,
        est: taskRegistry.estFounderMinutes,
      })
      .from(taskHealth)
      .innerJoin(taskRegistry, eq(taskRegistry.id, taskHealth.taskId))
      .where(and(eq(taskHealth.tenantId, tenantId), inArray(taskHealth.status, ["amber", "red"])));

    const inputs = [];
    for (const r of rows) {
      const [latest] = await tx
        .select({ status: verificationRun.status })
        .from(verificationRun)
        .where(and(eq(verificationRun.tenantId, tenantId), eq(verificationRun.taskId, r.taskId)))
        .orderBy(desc(verificationRun.ranAt))
        .limit(1);
      inputs.push({
        taskId: r.taskId,
        taskName: r.name,
        status: r.status,
        latestVerification: latest?.status ?? null,
        ledgerExceptionCount: r.openExc,
        estFounderMinutes: Number(r.est),
      });
    }
    return buildTaskExceptions(inputs);
  });
}

/**
 * Snapshots a tenant's portfolio metrics into tenant_ops_rollup (one row per
 * tenant, upserted by the sweep): coverage (full_auto tasks proven green out of
 * the whole task list), the status breakdown, open exceptions, 30d job count,
 * and founder-minutes. The portfolio view reads these — running N companies at a
 * glance.
 */
export async function computeTenantRollup(
  tenantId: string,
  opts: { now?: Date } = {},
): Promise<void> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - 30 * 86_400_000);
  await withTenant(tenantId, async (tx) => {
    const health = await tx
      .select({ status: taskHealth.status, mode: taskHealth.effectiveMode, openExc: taskHealth.openExceptionCount, fm: taskHealth.founderMinutes30d })
      .from(taskHealth)
      .where(eq(taskHealth.tenantId, tenantId));

    let fullAutoGreen = 0, greenCount = 0, amberCount = 0, redCount = 0, openExceptionCount = 0, founderMinutes = 0;
    for (const h of health) {
      if (h.status === "green") { greenCount++; if (h.mode === "full_auto") fullAutoGreen++; }
      else if (h.status === "amber") amberCount++;
      else if (h.status === "red") redCount++;
      openExceptionCount += h.openExc;
      founderMinutes += Number(h.fm);
    }

    const [tc] = await tx.select({ cnt: sql<number>`count(*)::int` }).from(taskRegistry);
    const [jc] = await tx.select({ cnt: sql<number>`count(*)::int` }).from(job).where(gte(job.createdAt, cutoff));

    const set = {
      fullAutoGreen, totalTasks: tc?.cnt ?? 0,
      greenCount, amberCount, redCount, openExceptionCount,
      jobs30d: jc?.cnt ?? 0, founderMinutes30d: String(founderMinutes), computedAt: now,
    };
    await tx
      .insert(tenantOpsRollup)
      .values({ tenantId, ...set })
      .onConflictDoUpdate({ target: tenantOpsRollup.tenantId, set });
  });
}
