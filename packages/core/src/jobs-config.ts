import { z } from "./schemas";
import type { JobType } from "./enums";

const jobsSchema = z.object({
  // days-in-stage before a job is "stuck"; terminal stages (lead/complete/lost) intentionally absent
  stageThresholds: z
    .object({
      inspected: z.number().int().min(1).default(3),
      estimate: z.number().int().min(1).default(7),
      approved: z.number().int().min(1).default(5),
      production: z.number().int().min(1).default(14),
      closeout: z.number().int().min(1).default(5),
      billing: z.number().int().min(1).default(10),
    })
    .default({}),
  // approved-date → expected completion, per job type
  buildSlaDays: z
    .object({
      retail: z.number().int().min(1).default(21),
      insurance: z.number().int().min(1).default(45),
      repair: z.number().int().min(1).default(10),
      commercial: z.number().int().min(1).default(60),
    })
    .default({}),
});

export type JobsConfig = z.infer<typeof jobsSchema>;

export function parseJobsConfig(raw: unknown): JobsConfig {
  return jobsSchema.parse(raw ?? {});
}

/**
 * Best-effort job lane heuristic. There is no retail/insurance flag on the lead;
 * lead.lane is "storm" | "tile" | "standard". Storm-damage leads are usually
 * insurance claims. Correctable later (piece G / editable type).
 */
export function leadToJobType(lane: string | null): JobType {
  return lane === "storm" ? "insurance" : "retail";
}
