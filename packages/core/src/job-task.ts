import type { JobType } from "./enums";

/** Which jobs a registry task applies to: job types (+ peril tags, unused yet). */
export type TaskAppliesTo = { job_types?: string[]; perils?: string[] };

/**
 * A registry task applies to a job when it carries no job-type restriction
 * (empty/absent `job_types` = "All") or explicitly lists the job's type. Pure so
 * instantiation filtering is unit-testable without a database.
 */
export function jobTaskApplies(appliesTo: TaskAppliesTo, jobType: JobType): boolean {
  const types = appliesTo.job_types;
  return !types || types.length === 0 || types.includes(jobType);
}
