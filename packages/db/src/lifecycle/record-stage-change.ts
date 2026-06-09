import { and, eq, isNull, sql } from "drizzle-orm";
import { job, jobTask, jobStageEvent, auditLog } from "../schema/index";
import { db } from "../client";
import type { JobStage, Agent } from "@savvy/core";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const DUE_DAYS = 3; // Phase 2 default SLA offset for activated tasks

/**
 * Moves a job to `toStage`: updates job.stage + stage_entered_at, writes a
 * job_stage_event, activates that stage's still-pending un-activated tasks
 * (sets due_at), writes an audit_log row. Idempotent: a repeat call with the
 * same toStage activates 0 new tasks.
 */
export async function recordStageChange(
  tx: Tx,
  opts: { tenantId: string; jobId: string; toStage: JobStage; byUserId?: string | null; byAgent?: Agent | null; now?: Date },
): Promise<{ activated: number; fromStage: JobStage | null }> {
  const now = opts.now ?? new Date();
  const [current] = await tx.select({ stage: job.stage }).from(job).where(eq(job.id, opts.jobId));
  const fromStage = (current?.stage ?? null) as JobStage | null;

  await tx.update(job).set({ stage: opts.toStage, stageEnteredAt: now }).where(eq(job.id, opts.jobId));

  await tx.insert(jobStageEvent).values({
    tenantId: opts.tenantId, jobId: opts.jobId, fromStage, toStage: opts.toStage,
    enteredAt: now, byUserId: opts.byUserId ?? null, byAgent: opts.byAgent ?? null,
  });

  const dueAt = new Date(now.getTime() + DUE_DAYS * 86_400_000);
  const res = await tx.update(jobTask).set({ dueAt }).where(
    and(
      eq(jobTask.jobId, opts.jobId),
      eq(jobTask.status, "pending"),
      isNull(jobTask.dueAt),
      sql`${jobTask.payload}->>'stage' = ${opts.toStage}`,
    ),
  ).returning({ id: jobTask.id });

  await tx.insert(auditLog).values({
    tenantId: opts.tenantId, agent: opts.byAgent ?? null, userId: opts.byUserId ?? null,
    entityType: "job", entityId: opts.jobId, action: "stage_changed",
    diff: { fromStage, toStage: opts.toStage, activatedTasks: res.length },
  });

  return { activated: res.length, fromStage };
}
