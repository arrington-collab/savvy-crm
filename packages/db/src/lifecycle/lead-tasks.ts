import { and, eq, inArray, sql } from "drizzle-orm";
import type { LeadStatus, EvidenceRef } from "@savvy/core";
import { withTenant, type Tx } from "../tenant";
import { lead, taskRegistry, tenantTaskConfig, leadTask } from "../schema/index";

// Non-terminal lead statuses — the ones a lead ledger is still live for.
const ACTIVE_STATUSES: LeadStatus[] = ["new", "contacted", "qualified", "booked"];

/**
 * Instantiates the Lead Ledger for one lead: every per_lead registry task that
 * isn't disabled for the tenant becomes a pending lead_task. Unlike jobs, leads
 * have no type yet, so applies_to.job_types is not a filter here. `blocked_by` =
 * the task's depends_on edges also being instantiated. Idempotent via the
 * (lead_id, task_id) unique constraint; takes a tx so it's atomic with lead
 * creation.
 */
export async function instantiateLeadTasks(
  tx: Tx,
  args: { tenantId: string; leadId: string },
): Promise<number> {
  const tasks = await tx
    .select({ id: taskRegistry.id, dependsOn: taskRegistry.dependsOn })
    .from(taskRegistry)
    .where(eq(taskRegistry.scope, "per_lead"));

  const disabled = await tx
    .select({ taskId: tenantTaskConfig.taskId })
    .from(tenantTaskConfig)
    .where(and(eq(tenantTaskConfig.tenantId, args.tenantId), eq(tenantTaskConfig.enabled, false)));
  const disabledSet = new Set(disabled.map((d) => d.taskId));

  const applicable = tasks.filter((t) => !disabledSet.has(t.id));
  if (applicable.length === 0) return 0;

  const presentIds = new Set(applicable.map((t) => t.id));
  const rows = applicable.map((t) => ({
    tenantId: args.tenantId,
    leadId: args.leadId,
    taskId: t.id,
    status: "pending" as const,
    blockedBy: t.dependsOn.filter((d) => presentIds.has(d)),
  }));

  await tx.insert(leadTask).values(rows).onConflictDoNothing({ target: [leadTask.leadId, leadTask.taskId] });
  return rows.length;
}

/**
 * Marks a lead_task `done` with the doer's evidence, then unblocks siblings by
 * removing this task from their blocked_by. Never grants `verified` — only the
 * health sweep does. Mirror of markJobTaskDone.
 */
export type MarkLeadTaskArgs = { leadId: string; taskId: number; owner?: string; evidence?: EvidenceRef; agentRunId?: string };

/** Transaction-joining variant of markLeadTaskDone (atomic evidence writes). No-op if the row is absent. */
export async function markLeadTaskDoneTx(tx: Tx, tenantId: string, args: MarkLeadTaskArgs): Promise<void> {
  await tx
    .update(leadTask)
    .set({
      status: "done",
      owner: args.owner ?? null,
      evidence: args.evidence ?? null,
      agentRunId: args.agentRunId ?? null,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(leadTask.tenantId, tenantId), eq(leadTask.leadId, args.leadId), eq(leadTask.taskId, args.taskId)));

  await tx
    .update(leadTask)
    .set({ blockedBy: sql`array_remove(${leadTask.blockedBy}, ${args.taskId})`, updatedAt: new Date() })
    .where(
      and(
        eq(leadTask.tenantId, tenantId),
        eq(leadTask.leadId, args.leadId),
        sql`${args.taskId} = ANY(${leadTask.blockedBy})`,
      ),
    );
}

export async function markLeadTaskDone(tenantId: string, args: MarkLeadTaskArgs): Promise<void> {
  await withTenant(tenantId, (tx) => markLeadTaskDoneTx(tx, tenantId, args));
}

/**
 * Backfills the Lead Ledger for every active (non-terminal) lead in the tenant.
 * Idempotent. Mirror of backfillJobTasks.
 */
export async function backfillLeadTasks(tenantId: string): Promise<number> {
  return withTenant(tenantId, async (tx) => {
    const leads = await tx
      .select({ id: lead.id })
      .from(lead)
      .where(inArray(lead.status, ACTIVE_STATUSES));
    let total = 0;
    for (const l of leads) {
      total += await instantiateLeadTasks(tx, { tenantId, leadId: l.id });
    }
    return total;
  });
}
