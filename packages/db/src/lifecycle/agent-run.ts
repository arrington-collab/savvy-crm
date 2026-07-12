import { and, asc, desc, eq, gte, isNotNull, lt, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { withTenant } from "../tenant";
import { agentRun, job, lead, customer } from "../schema/index";
import { SHOWCASE, type Agent, type AgentRunLite } from "@savvy/core";

export type AgentRunStatus = "running" | "ok" | "error" | "skipped";

/**
 * One consistent write-path for agent activity. Opens its own withTenant tx
 * (matches the existing ad-hoc inserts). `status` is free text by convention:
 * running|ok|error|skipped (skipped = a legitimate no-op, e.g. Stripe unconfigured).
 */
export async function beginAgentRun(input: {
  tenantId: string;
  agent: Agent;
  taskKey: string;
  jobId?: string | null;
  leadId?: string | null;
  inngestRunId?: string | null;
  modelUsed?: string | null;
}): Promise<string> {
  return withTenant(input.tenantId, async (tx) => {
    const [row] = await tx
      .insert(agentRun)
      .values({
        tenantId: input.tenantId,
        agent: input.agent,
        taskKey: input.taskKey,
        status: "running",
        jobId: input.jobId ?? null,
        leadId: input.leadId ?? null,
        inngestRunId: input.inngestRunId ?? null,
        modelUsed: input.modelUsed ?? null,
        finishedAt: null,
      })
      .returning({ id: agentRun.id });
    return row!.id;
  });
}

export async function completeAgentRun(input: {
  tenantId: string;
  runId: string;
  status: Exclude<AgentRunStatus, "running">;
  tokens?: number | null;
  costCents?: number | null;
  modelUsed?: string | null;
  error?: string | null;
}): Promise<void> {
  await withTenant(input.tenantId, (tx) =>
    tx
      .update(agentRun)
      .set({
        status: input.status,
        tokens: input.tokens ?? null,
        costCents: input.costCents ?? null,
        modelUsed: input.modelUsed ?? undefined, // keep begin's model if not re-supplied
        error: input.error ?? null,
        finishedAt: new Date(),
      })
      .where(eq(agentRun.id, input.runId)),
  );
}

/** Back-compat wrapper: one-shot terminal write, identical to the old behaviour. */
export async function recordAgentRun(input: {
  tenantId: string;
  agent: Agent;
  taskKey: string;
  status: Exclude<AgentRunStatus, "running">;
  jobId?: string | null;
  leadId?: string | null;
  modelUsed?: string | null;
  tokens?: number | null;
  costCents?: number | null;
  inngestRunId?: string | null;
  error?: string | null;
}): Promise<void> {
  const runId = await beginAgentRun({
    tenantId: input.tenantId,
    agent: input.agent,
    taskKey: input.taskKey,
    jobId: input.jobId,
    leadId: input.leadId,
    inngestRunId: input.inngestRunId,
    modelUsed: input.modelUsed,
  });
  await completeAgentRun({
    tenantId: input.tenantId,
    runId,
    status: input.status,
    tokens: input.tokens,
    costCents: input.costCents,
    modelUsed: input.modelUsed,
    error: input.error,
  });
}

export interface AgentActivityRow {
  id: string;
  agent: string;
  taskKey: string | null;
  status: string;
  modelUsed: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  /** Customer name the run worked on, via job→customer OR lead→customer. */
  target: string | null;
  error: string | null;
}

/**
 * Detailed command-center feed: newest runs with the customer name resolved
 * through EITHER the linked job or the linked lead (whichever the run carries).
 * RLS-scoped via withTenant, so it only ever returns the caller tenant's runs.
 */
export async function listAgentActivity(
  tenantId: string,
  opts: { limit: number; before?: Date; agent?: string; status?: string; jobId?: string; leadId?: string },
): Promise<AgentActivityRow[]> {
  const jobCustomer = alias(customer, "job_customer");
  const leadCustomer = alias(customer, "lead_customer");
  const conds: SQL[] = [];
  // Cursor is startedAt-only: rows sharing an identical startedAt at a page
  // boundary can be skipped on the next poll. Accepted limitation for this
  // internal, top-polled feed — a composite cursor is out of scope here.
  if (opts.before) conds.push(lt(agentRun.startedAt, opts.before));
  if (opts.agent) conds.push(eq(agentRun.agent, opts.agent as Agent));
  if (opts.status) conds.push(eq(agentRun.status, opts.status));
  if (opts.jobId) conds.push(eq(agentRun.jobId, opts.jobId));
  if (opts.leadId) conds.push(eq(agentRun.leadId, opts.leadId));
  return withTenant(tenantId, (tx) =>
    tx
      .select({
        id: agentRun.id,
        agent: agentRun.agent,
        taskKey: agentRun.taskKey,
        status: agentRun.status,
        modelUsed: agentRun.modelUsed,
        startedAt: agentRun.startedAt,
        finishedAt: agentRun.finishedAt,
        target: sql<string | null>`coalesce(${jobCustomer.name}, ${leadCustomer.name})`,
        error: agentRun.error,
      })
      .from(agentRun)
      .leftJoin(job, eq(job.id, agentRun.jobId))
      .leftJoin(jobCustomer, eq(jobCustomer.id, job.customerId))
      .leftJoin(lead, eq(lead.id, agentRun.leadId))
      .leftJoin(leadCustomer, eq(leadCustomer.id, lead.customerId))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(agentRun.startedAt), desc(agentRun.id))
      .limit(opts.limit),
  );
}

/**
 * One calendar day's runs, OLDEST first, for the replay scrubber. Same customer-name
 * join as listAgentActivity, bounded to `[start, end)` and ordered ASC by startedAt so
 * the timeline plays forward. RLS-scoped, SELECT-only.
 */
export async function listAgentActivityForDay(
  tenantId: string,
  window: { start: Date; end: Date },
): Promise<AgentActivityRow[]> {
  const jobCustomer = alias(customer, "job_customer");
  const leadCustomer = alias(customer, "lead_customer");
  return withTenant(tenantId, (tx) =>
    tx
      .select({
        id: agentRun.id,
        agent: agentRun.agent,
        taskKey: agentRun.taskKey,
        status: agentRun.status,
        modelUsed: agentRun.modelUsed,
        startedAt: agentRun.startedAt,
        finishedAt: agentRun.finishedAt,
        target: sql<string | null>`coalesce(${jobCustomer.name}, ${leadCustomer.name})`,
        error: agentRun.error,
      })
      .from(agentRun)
      .leftJoin(job, eq(job.id, agentRun.jobId))
      .leftJoin(jobCustomer, eq(jobCustomer.id, job.customerId))
      .leftJoin(lead, eq(lead.id, agentRun.leadId))
      .leftJoin(leadCustomer, eq(leadCustomer.id, lead.customerId))
      .where(and(gte(agentRun.startedAt, window.start), lt(agentRun.startedAt, window.end)))
      .orderBy(asc(agentRun.startedAt), asc(agentRun.id)),
  );
}

/**
 * Runs `work` with a live agent_run: opens a `running` row (visible in-flight),
 * then completes it ok (or a caller-mapped status) on success, or error+rethrow
 * on throw. Wrap ONLY the slow work you want to show as in-flight — for
 * skip-with-reason paths, call this AFTER the guard so you never flash a
 * spinner for a run that wasn't really working.
 *
 * Orphan guard: when this runs inside an Inngest `step.run`, a step retry
 * re-executes `work` from scratch, which can leave a prior `running` row
 * orphaned (its own try/catch never fires because the step process was
 * killed/retried out from under it). We don't try to detect that here —
 * the reaper (`markStaleRunsTimedOut`, 10 min cutoff) plus the 90s UI
 * spinner cap are the intended guards against an orphaned row spinning
 * forever.
 */
export async function withAgentRun<T>(
  meta: {
    tenantId: string; agent: Agent; taskKey: string;
    jobId?: string | null; leadId?: string | null; modelUsed?: string | null;
  },
  work: () => Promise<T>,
  opts: {
    resolve?: (result: T) => { status: Exclude<AgentRunStatus, "running">; error?: string | null; modelUsed?: string | null };
  } = {},
): Promise<T> {
  const runId = await beginAgentRun({
    tenantId: meta.tenantId, agent: meta.agent, taskKey: meta.taskKey,
    jobId: meta.jobId ?? null, leadId: meta.leadId ?? null, modelUsed: meta.modelUsed ?? null,
  });
  try {
    const result = await work();
    const r = opts.resolve?.(result) ?? { status: "ok" as const };
    await completeAgentRun({ tenantId: meta.tenantId, runId, status: r.status, error: r.error ?? null, modelUsed: r.modelUsed ?? null });
    return result;
  } catch (e) {
    try {
      await completeAgentRun({
        tenantId: meta.tenantId,
        runId,
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    } catch {
      // Swallow: don't let a failure to close the run row mask the original error.
    }
    throw e;
  }
}

export interface RunningRunRow {
  id: string;
  agent: string;
  taskKey: string | null;
  jobId: string | null;
  leadId: string | null;
  startedAt: Date;
}

/** Open (`running`) runs attributed to a job or lead — drives the in-flight dots. */
export async function listRunningRuns(tenantId: string): Promise<RunningRunRow[]> {
  return withTenant(tenantId, (tx) =>
    tx.select({
      id: agentRun.id, agent: agentRun.agent, taskKey: agentRun.taskKey,
      jobId: agentRun.jobId, leadId: agentRun.leadId, startedAt: agentRun.startedAt,
    })
      .from(agentRun)
      .where(and(
        eq(agentRun.status, "running"),
        or(isNotNull(agentRun.jobId), isNotNull(agentRun.leadId)),
        // A stalled reaper (markStaleRunsTimedOut hasn't run) shouldn't let this
        // poll grow unboundedly — bound to the spinner window plus a hard limit.
        gte(agentRun.startedAt, new Date(Date.now() - SHOWCASE.SPINNER_MAX_SECONDS * 1000)),
      ))
      .orderBy(desc(agentRun.startedAt))
      .limit(200),
  );
}

/**
 * Lite agent_run rows since `since`, for coverage rollups (`summarizeAgentCoverage`).
 * RLS-scoped via withTenant, so it only ever returns the caller tenant's runs.
 */
export async function loadAgentCoverageWindow(tenantId: string, since: Date): Promise<AgentRunLite[]> {
  const rows = await withTenant(tenantId, (tx) =>
    tx
      .select({ agent: agentRun.agent, status: agentRun.status, modelUsed: agentRun.modelUsed, costCents: agentRun.costCents, startedAt: agentRun.startedAt })
      .from(agentRun)
      .where(and(eq(agentRun.tenantId, tenantId), gte(agentRun.startedAt, since)))
      .orderBy(desc(agentRun.startedAt)),
  );
  return rows.map((r) => ({
    agent: r.agent as Agent,
    status: r.status,
    modelUsed: r.modelUsed,
    costCents: r.costCents,
    startedAt: new Date(r.startedAt as unknown as string),
  }));
}

/** Reaper: close running rows older than the cutoff so no card spins forever. */
export async function markStaleRunsTimedOut(tenantId: string, cutoff: Date): Promise<number> {
  return withTenant(tenantId, async (tx) => {
    const res = await tx.update(agentRun)
      .set({ status: "error", error: "timed_out", finishedAt: new Date() })
      .where(and(eq(agentRun.status, "running"), lt(agentRun.startedAt, cutoff)))
      .returning({ id: agentRun.id });
    return res.length;
  });
}
