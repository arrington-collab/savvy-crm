import { jobTask } from "../schema/index";
import { TASK_TEMPLATES } from "../seed-data/templates";
import type { JobType } from "@savvy/core";

// Minimal tx shape we need (a drizzle transaction). Keep loose to avoid the
// fragile full Tx generic; callers pass a real withTenant tx.
type InsertTx = { insert: (table: typeof jobTask) => { values: (rows: unknown[]) => Promise<unknown> } };

/**
 * Seeds every non-org template matching the job's type as a pending job_task.
 * Call once per job at creation. Returns the number of tasks seeded.
 */
export async function seedJobTasks(
  tx: InsertTx,
  job: { id: string; tenantId: string; type: JobType },
): Promise<number> {
  const templates = TASK_TEMPLATES.filter((t) => !t.orgLevel && t.jobTypes.includes(job.type));
  if (templates.length === 0) return 0;
  await tx.insert(jobTask).values(
    templates.map((t) => ({
      tenantId: job.tenantId,
      jobId: job.id,
      key: t.key,
      title: t.title,
      phase: t.phase,
      ownerAgent: t.ownerAgent ?? null,
      automationLevel: t.automationLevel,
      status: "pending" as const,
      dueAt: null,
      payload: {
        num: t.num, stage: t.stage, difficulty: t.difficulty,
        trigger: t.trigger, ownerRole: t.ownerRole, whatGetsAutomated: t.whatGetsAutomated,
      },
    })),
  );
  return templates.length;
}
