import { z } from "./schemas";

export const ASSIGNMENT_STRATEGY = ["off", "round_robin", "least_loaded", "territory", "score", "proximity"] as const;
export type AssignmentStrategy = (typeof ASSIGNMENT_STRATEGY)[number];

export type AssignmentConfig = {
  strategy: AssignmentStrategy;
  territoryRules?: { state: string; city?: string; userId: string }[];
  scoreTiers?: { minScore: number; userIds: string[] }[];
};

export const assignmentConfigSchema = z.object({
  strategy: z.enum(ASSIGNMENT_STRATEGY),
  territoryRules: z
    .array(z.object({ state: z.string().min(1).max(40), city: z.string().max(120).optional(), userId: z.string().min(1) }))
    .optional(),
  scoreTiers: z
    .array(z.object({ minScore: z.number().int().min(0).max(100), userIds: z.array(z.string().min(1)) }))
    .optional(),
});

export function parseAssignmentConfig(raw: unknown): AssignmentConfig {
  const parsed = assignmentConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : { strategy: "off" };
}
