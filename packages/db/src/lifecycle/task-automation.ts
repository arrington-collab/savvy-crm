import { and, eq, sql } from "drizzle-orm";
import { jobChecklistItem } from "../schema/index";
import { db } from "../client";
import { withTenant } from "../tenant";
import { recordAgentRun } from "./agent-run";
import { shouldAutoAct } from "@savvy/core";
import type { Agent } from "@savvy/core";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The owning task's automationLevel for (jobId, key); "full" when no task matches (never blocks). */
export async function resolveTaskAutomation(tx: Tx, jobId: string, taskKey: string): Promise<string> {
  const [t] = await tx
    .select({ level: jobChecklistItem.automationLevel })
    .from(jobChecklistItem)
    .where(and(eq(jobChecklistItem.jobId, jobId), eq(jobChecklistItem.key, taskKey)))
    .limit(1);
  return t?.level ?? "full";
}

/**
 * Runtime automation gate. Reads the owning task's automationLevel; if it is not
 * `full`, DEFERS: marks the task `deferred_at = now` (so it surfaces in /exceptions)
 * and logs a skipped agent_run. Returns whether the caller may proceed.
 */
export async function gateAgentAutomation(input: {
  tenantId: string; jobId: string; taskKey: string; agent: Agent;
}): Promise<{ proceed: boolean; level: string }> {
  const level = await withTenant(input.tenantId, (tx) => resolveTaskAutomation(tx, input.jobId, input.taskKey));
  if (shouldAutoAct(level)) return { proceed: true, level };

  await withTenant(input.tenantId, (tx) =>
    tx.update(jobChecklistItem)
      .set({ deferredAt: new Date() })
      .where(and(
        eq(jobChecklistItem.jobId, input.jobId),
        eq(jobChecklistItem.key, input.taskKey),
        sql`${jobChecklistItem.status} not in ('done','skipped')`,
      )),
  );
  await recordAgentRun({
    tenantId: input.tenantId, agent: input.agent, taskKey: input.taskKey, jobId: input.jobId,
    status: "skipped", error: `automation:${level} — deferred to human`,
  });
  return { proceed: false, level };
}
