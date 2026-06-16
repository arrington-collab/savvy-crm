import { withTenant } from "../tenant";
import { agentRun } from "../schema/index";
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
      modelUsed: input.modelUsed ?? null,
      tokens: input.tokens ?? null,
      costCents: input.costCents ?? null,
      inngestRunId: input.inngestRunId ?? null,
      error: input.error ?? null,
      finishedAt: new Date(),
    }),
  );
}
