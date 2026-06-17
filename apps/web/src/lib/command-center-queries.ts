import "server-only";
import { withTenant, agentRun, job, customer, desc, eq, gte } from "@savvy/db";
import type { AgentRunLite } from "@savvy/core";
import { getTenantId } from "./tenant";

/** Lite rows for the pure rollups (coverage + stats), within a trailing N-day window. */
export async function getAgentRunWindow(tenantId: string, days: number): Promise<AgentRunLite[]> {
  const since = new Date(Date.now() - days * 86_400_000);
  return withTenant(tenantId, (tx) =>
    tx.select({
      agent: agentRun.agent,
      status: agentRun.status,
      modelUsed: agentRun.modelUsed,
      costCents: agentRun.costCents,
      startedAt: agentRun.startedAt,
    }).from(agentRun).where(gte(agentRun.startedAt, since)),
  );
}

export type ActivityRow = {
  id: string;
  agent: string;
  taskKey: string | null;
  status: string;
  modelUsed: string | null;
  startedAt: Date;
  target: string | null;
};

/** Detailed feed: newest runs joined to the customer name (via job) for a readable target. */
export async function getAgentActivity(tenantId: string, limit: number): Promise<ActivityRow[]> {
  return withTenant(tenantId, (tx) =>
    tx.select({
      id: agentRun.id,
      agent: agentRun.agent,
      taskKey: agentRun.taskKey,
      status: agentRun.status,
      modelUsed: agentRun.modelUsed,
      startedAt: agentRun.startedAt,
      target: customer.name,
    })
      .from(agentRun)
      .leftJoin(job, eq(job.id, agentRun.jobId))
      .leftJoin(customer, eq(customer.id, job.customerId))
      .orderBy(desc(agentRun.startedAt))
      .limit(limit),
  );
}

// Page-facing wrappers (resolve the active tenant from Clerk/TEST_MODE).
export async function loadAgentRunWindow(days = 30) { return getAgentRunWindow(await getTenantId(), days); }
export async function loadAgentActivity(limit = 30) { return getAgentActivity(await getTenantId(), limit); }
