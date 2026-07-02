import { and, eq, inArray, sql } from "drizzle-orm";
import { jobTaskApplies, type JobType, type JobStage, type EvidenceRef } from "@savvy/core";
import { withTenant, type Tx } from "../tenant";
import { job, taskRegistry, tenantTaskConfig, jobTask } from "../schema/index";

// Non-terminal job stages — the ones a job ledger is still live for.
const ACTIVE_STAGES: JobStage[] = ["lead", "inspected", "estimate", "approved", "production", "closeout", "billing"];

/**
 * Instantiates the Job Ledger for one job: every per_job registry task that
 * matches the job's type and isn't disabled for the tenant becomes a pending
 * job_task. `blocked_by` = the task's depends_on edges that are also being
 * instantiated (at creation nothing is done yet, so every present dep blocks).
 * Idempotent via the (job_id, task_id) unique constraint — safe to re-run for
 * backfill. Takes a tx so it's atomic with job creation.
 */
export async function instantiateJobTasks(
  tx: Tx,
  args: { tenantId: string; jobId: string; jobType: JobType },
): Promise<number> {
  const tasks = await tx
    .select({ id: taskRegistry.id, appliesTo: taskRegistry.appliesTo, dependsOn: taskRegistry.dependsOn })
    .from(taskRegistry)
    .where(eq(taskRegistry.scope, "per_job"));

  const disabled = await tx
    .select({ taskId: tenantTaskConfig.taskId })
    .from(tenantTaskConfig)
    .where(and(eq(tenantTaskConfig.tenantId, args.tenantId), eq(tenantTaskConfig.enabled, false)));
  const disabledSet = new Set(disabled.map((d) => d.taskId));

  const applicable = tasks.filter((t) => jobTaskApplies(t.appliesTo, args.jobType) && !disabledSet.has(t.id));
  if (applicable.length === 0) return 0;

  const presentIds = new Set(applicable.map((t) => t.id));
  const rows = applicable.map((t) => ({
    tenantId: args.tenantId,
    jobId: args.jobId,
    taskId: t.id,
    status: "pending" as const,
    blockedBy: t.dependsOn.filter((d) => presentIds.has(d)),
  }));

  await tx.insert(jobTask).values(rows).onConflictDoNothing({ target: [jobTask.jobId, jobTask.taskId] });
  return rows.length;
}

/**
 * Marks a job_task `done` with the doer's evidence (never `verified` — only the
 * health sweep grants that), then unblocks siblings by removing this task from
 * their blocked_by. The doer claims done; the checker (sweep) grants verified.
 */
export async function markJobTaskDone(
  tenantId: string,
  args: { jobId: string; taskId: number; owner?: string; evidence?: EvidenceRef; agentRunId?: string },
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx
      .update(jobTask)
      .set({
        status: "done",
        owner: args.owner ?? null,
        evidence: args.evidence ?? null,
        agentRunId: args.agentRunId ?? null,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(jobTask.tenantId, tenantId), eq(jobTask.jobId, args.jobId), eq(jobTask.taskId, args.taskId)));

    await tx
      .update(jobTask)
      .set({ blockedBy: sql`array_remove(${jobTask.blockedBy}, ${args.taskId})`, updatedAt: new Date() })
      .where(
        and(
          eq(jobTask.tenantId, tenantId),
          eq(jobTask.jobId, args.jobId),
          sql`${args.taskId} = ANY(${jobTask.blockedBy})`,
        ),
      );
  });
}

/**
 * Backfills the Job Ledger for every active (non-terminal) job in the tenant.
 * Idempotent — jobs that already have their tasks are untouched. For rolling out
 * the registry to tenants whose jobs predate instantiation.
 */
export async function backfillJobTasks(tenantId: string): Promise<number> {
  return withTenant(tenantId, async (tx) => {
    const jobs = await tx
      .select({ id: job.id, type: job.type })
      .from(job)
      .where(inArray(job.stage, ACTIVE_STAGES));
    let total = 0;
    for (const j of jobs) {
      total += await instantiateJobTasks(tx, { tenantId, jobId: j.id, jobType: j.type });
    }
    return total;
  });
}
