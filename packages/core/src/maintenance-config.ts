import { z } from "zod";

// Phase 20 — maintenance & recurring revenue. The annual tune-up price is a
// LIBRARY DEFAULT the owner edits, not a business number we invented: $348/yr
// ($29/mo equivalent) seeded as a starting point, shown editable in settings.

const maintenanceConfigSchema = z.object({
  enabled: z.boolean().catch(true).default(true),
  annualPriceCents: z.number().int().min(0).catch(34_800).default(34_800),
});
export type MaintenanceConfig = z.infer<typeof maintenanceConfigSchema>;

export function parseMaintenanceConfig(raw: unknown): MaintenanceConfig {
  const r = maintenanceConfigSchema.safeParse(raw ?? {});
  return r.success ? r.data : maintenanceConfigSchema.parse({});
}

/** Monthly-equivalent cents for an annual membership (floor — never overstate MRR). */
export function monthlyEquivalentCents(annualPriceCents: number): number {
  return Math.floor(annualPriceCents / 12);
}
