import { withTenant, job, jobStageEvent, agentRun, user, count, desc, eq } from "@savvy/db";
import { JOB_STAGE, computeVelocity, summarizeRepPerformance } from "@savvy/core";
import { getTenantId } from "./tenant";

export async function getPipelineCounts(): Promise<{ byStage: Record<string, number>; total: number }> {
  const tenantId = await getTenantId();
  const rows = await withTenant(tenantId, (tx) =>
    tx.select({ stage: job.stage, n: count() }).from(job).groupBy(job.stage),
  );
  const byStage = Object.fromEntries(JOB_STAGE.map((s) => [s, 0])) as Record<string, number>;
  for (const r of rows) byStage[r.stage] = Number(r.n);
  const total = Object.values(byStage).reduce((a, b) => a + b, 0);
  return { byStage, total };
}

export async function getRecentAgentRuns() {
  const tenantId = await getTenantId();
  return withTenant(tenantId, (tx) =>
    tx.select().from(agentRun).orderBy(desc(agentRun.startedAt)).limit(5),
  );
}

export async function getVelocity() {
  const tenantId = await getTenantId();
  const events = await withTenant(tenantId, (tx) =>
    tx
      .select({ jobId: jobStageEvent.jobId, toStage: jobStageEvent.toStage, enteredAt: jobStageEvent.enteredAt })
      .from(jobStageEvent),
  );
  return computeVelocity(
    events.map((e) => ({ jobId: e.jobId, toStage: e.toStage ?? "", enteredAt: e.enteredAt })),
  );
}

export async function getRepPerformance() {
  const tenantId = await getTenantId();
  const rows = await withTenant(tenantId, (tx) =>
    tx
      .select({
        userId: job.assignedUserId,
        name: user.name,
        stage: job.stage,
        valueCents: job.valueEstimate,
        openedAt: job.openedAt,
        closedAt: job.closedAt,
      })
      .from(job)
      .innerJoin(user, eq(user.id, job.assignedUserId)),
  );
  const DAY = 86_400_000;
  return summarizeRepPerformance(
    rows.map((r) => ({
      userId: r.userId!,
      name: r.name,
      stage: r.stage,
      valueCents: r.valueCents ?? 0,
      daysToClose:
        r.openedAt && r.closedAt
          ? (r.closedAt.getTime() - r.openedAt.getTime()) / DAY
          : null,
    })),
  );
}
