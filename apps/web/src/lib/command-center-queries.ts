import "server-only";
import { withTenant, agentRun, gte, listAgentActivity, listAgentActivityForDay, type AgentActivityRow } from "@savvy/db";
import type { AgentRunLite } from "@savvy/core";
import { verbFor, replayDayBounds } from "@savvy/core";
import { getTenantId } from "./tenant";
import { getTenantIdentity } from "./today-queries";

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
  return listAgentActivity(tenantId, { limit });
}

// Page-facing wrappers (resolve the active tenant from Clerk/TEST_MODE).
export async function loadAgentRunWindow(days = 30) { return getAgentRunWindow(await getTenantId(), days); }
export async function loadAgentActivity(limit = 30) { return getAgentActivity(await getTenantId(), limit); }

/** Feed row with the plain-words verb/category resolved from taskKey — never render the dotted machine key. */
export interface FeedRow extends ActivityRow { verb: string; category: string }

/**
 * Poll-friendly activity feed page: tenant-scoped rows plus a `nextCursor`
 * (last row's startedAt, ISO) for "load more" — null once the page isn't full.
 */
export async function loadActivityPage(opts: {
  limit?: number;
  before?: Date;
  agent?: string;
  status?: string;
  jobId?: string;
}): Promise<{ rows: FeedRow[]; nextCursor: string | null }> {
  const limit = opts.limit ?? 30;
  const raw = await listAgentActivity(await getTenantId(), { ...opts, limit });
  const rows = raw.map((r) => ({ ...r, ...verbFor(r.taskKey) }));
  const nextCursor = raw.length === limit ? raw[raw.length - 1]!.startedAt.toISOString() : null;
  return { rows, nextCursor };
}

/**
 * One tenant-local calendar day of activity, oldest-first, for the replay scrubber.
 * Read-only + tenant-scoped. `startMs`/`endMs` are the day's UTC bounds so the client
 * can map wall-clock progress to `startedAt`.
 */
export async function loadReplayDay(date: string): Promise<{ rows: FeedRow[]; date: string; startMs: number; endMs: number }> {
  const { timezone } = await getTenantIdentity();
  const { start, end } = replayDayBounds(date, timezone);
  const raw = await listAgentActivityForDay(await getTenantId(), { start, end });
  const rows = raw.map((r) => ({ ...r, ...verbFor(r.taskKey) }));
  return { rows, date, startMs: start.getTime(), endMs: end.getTime() };
}
