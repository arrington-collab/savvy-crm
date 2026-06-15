import { z } from "./schemas";
import type { JobType } from "./enums";

/** Required labels with no case-insensitive/trimmed match in `present`. [] = complete. */
export function missingRequiredPhotos(required: string[], present: string[]): string[] {
  const have = new Set(present.map((s) => s.trim().toLowerCase()));
  return required.filter((r) => !have.has(r.trim().toLowerCase()));
}

const DEFAULTS: Record<JobType, string[]> = {
  retail: ["before", "after"],
  insurance: ["before", "after", "permit"],
  repair: ["before", "after"],
  commercial: ["before", "after"],
};

const labels = (def: string[]) =>
  z.array(z.string()).default(def).transform((a) => a.map((s) => s.trim().toLowerCase()));

const productionSchema = z.object({
  requiredPhotos: z.object({
    retail: labels(DEFAULTS.retail),
    insurance: labels(DEFAULTS.insurance),
    repair: labels(DEFAULTS.repair),
    commercial: labels(DEFAULTS.commercial),
  }).default({}),
});

export type ProductionConfig = z.infer<typeof productionSchema>;

export function parseProductionConfig(raw: unknown): ProductionConfig {
  return productionSchema.parse(raw ?? {});
}
