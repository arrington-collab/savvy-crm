import { withTenant, job, agentRun, count, desc } from "@savvy/db";
import { JOB_STAGE } from "@savvy/core";
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
