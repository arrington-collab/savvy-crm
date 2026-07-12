import { z } from "zod";

// Per-tenant ballpark gate (tenant.settings.ballpark). Dormant by default:
// enabled=false, retail-only. All spreads/floors in basis points.
const schema = z.object({
  enabled: z.boolean().default(false),
  retailOnly: z.boolean().default(true),
  betterMultiplierBps: z.number().int().min(10000).default(12500), // ≥1.0×; better tier over good
  spreadBps: z.number().int().min(0).max(10000).default(1000), // ±10%
  marginFloorBps: z.number().int().min(0).default(2000), // low end ≥ cost +20%
  confidenceFloor: z.enum(["measured", "assessor", "footprint"]).default("assessor"),
});

export type BallparkConfig = z.infer<typeof schema>;

export function parseBallparkConfig(raw: unknown): BallparkConfig {
  return schema.parse(raw ?? {});
}
