import { desc, eq, sql } from "drizzle-orm";
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
export async function recordAgentRun(input: {
  tenantId: string;
  agent: Agent;
  taskKey: string;
  status: AgentRunStatus;
  jobId?: string | null;
  leadId?: string | null;
  modelUsed?: string | null;
  tokens?: number | null;
  costCents?: number | null;
  inngestRunId?: string | null;
  error?: string | null;
}): Promise<void> {
  await withTenant(input.tenantId, (tx) =>
    tx.insert(agentRun).values({
      tenantId: input.tenantId,
      agent: input.agent,
      taskKey: input.taskKey,
      status: input.status,
      jobId: input.jobId ?? null,
      leadId: input.leadId ?? null,
      modelUsed: input.modelUsed ?? null,
      tokens: input.tokens ?? null,
      costCents: input.costCents ?? null,
      inngestRunId: input.inngestRunId ?? null,
      error: input.error ?? null,
      finishedAt: new Date(),
    }),
  );
}

export interface AgentActivityRow {
  id: string;
  agent: string;
  taskKey: string | null;
  status: string;
  modelUsed: string | null;
  startedAt: Date;
  /** Customer name the run worked on, via job→customer OR lead→customer. */
  target: string | null;
  error: string | null;
}

/**
 * Detailed command-center feed: newest runs with the customer name resolved
 * through EITHER the linked job or the linked lead (whichever the run carries).
 * RLS-scoped via withTenant, so it only ever returns the caller tenant's runs.
 */
export async function listAgentActivity(tenantId: string, limit: number): Promise<AgentActivityRow[]> {
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
        target: sql<string | null>`coalesce(${jobCustomer.name}, ${leadCustomer.name})`,
        error: agentRun.error,
      })
      .from(agentRun)
      .leftJoin(job, eq(job.id, agentRun.jobId))
      .leftJoin(jobCustomer, eq(jobCustomer.id, job.customerId))
      .leftJoin(lead, eq(lead.id, agentRun.leadId))
      .leftJoin(leadCustomer, eq(leadCustomer.id, lead.customerId))
      .orderBy(desc(agentRun.startedAt))
      .limit(limit),
  );
}
