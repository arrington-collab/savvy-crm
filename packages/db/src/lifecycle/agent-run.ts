import { and, desc, eq, lt, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { withTenant } from "../tenant";
import { agentRun, job, lead, customer } from "../schema/index";
import type { Agent } from "@savvy/core";

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
  opts: { limit: number; before?: Date; agent?: string; status?: string; jobId?: string },
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
