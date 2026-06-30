import "server-only";
import { withTenant, agentRun, gte, listAgentActivity, type AgentActivityRow } from "@savvy/db";
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

export type ActivityRow = AgentActivityRow;

/**
 * Detailed feed: newest runs with the customer name resolved via job OR lead.
 * The join lives in @savvy/db (listAgentActivity) so it's integration-tested
 * against Postgres; this is a thin tenant-scoped delegate.
 */
export async function getAgentActivity(tenantId: string, limit: number): Promise<ActivityRow[]> {
  return listAgentActivity(tenantId, limit);
}

// Page-facing wrappers (resolve the active tenant from Clerk/TEST_MODE).
export async function loadAgentRunWindow(days = 30) { return getAgentRunWindow(await getTenantId(), days); }
export async function loadAgentActivity(limit = 30) { return getAgentActivity(await getTenantId(), limit); }
