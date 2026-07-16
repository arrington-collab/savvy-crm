import { z } from "zod";

// Phase 26 slice 1 — mobilization blitz (spec: docs/superpowers/specs/
// prompts-phase26-margin-market.md). 3-wave postcard blitz to the closest
// homes when a build is scheduled, graded against a 1-roof-per-7-jobs target.
// All thresholds are Library config, not code.

const blitzConfigSchema = z.object({
  enabled: z.boolean().catch(true).default(true),
  // Owner decision: 25–50 homes. Default 30; a size configured above
  // audienceMax forces the approval card (never a silent oversized send).
  audienceSize: z.number().int().min(1).catch(30).default(30),
  audienceMax: z.number().int().min(1).catch(50).default(50),
  pieceCostCents: z.number().int().min(0).catch(143).default(143), // ~$129 / (30 homes × 3 waves)
  perJobCapCents: z.number().int().min(0).catch(15000).default(15000), // $150 auto-approve ceiling
  waveLeadDays: z.number().int().min(1).catch(7).default(7), // wave 1 mails this long before build start
  radiusMeters: z.number().int().min(100).catch(1500).default(1500),
  targetRoofsPerJobs: z.number().int().min(1).catch(7).default(7),
});
export type BlitzConfig = z.infer<typeof blitzConfigSchema>;

const BLITZ_DEFAULTS: BlitzConfig = {
  enabled: true, audienceSize: 30, audienceMax: 50, pieceCostCents: 143,
  perJobCapCents: 15000, waveLeadDays: 7, radiusMeters: 1500, targetRoofsPerJobs: 7,
};

export function parseBlitzConfig(raw: unknown): BlitzConfig {
  const r = blitzConfigSchema.safeParse(raw ?? {});
  return r.success ? r.data : BLITZ_DEFAULTS;
}

/**
 * Marketing copy carries the street name and NEVER a house number
 * ("your neighbor on <STREET> is getting a new roof"). Strips the leading
 * number block from the first address segment.
 */
export function streetNameFromAddress(address: string): string {
  const segment = address.split(",")[0] ?? "";
  return segment.replace(/^\s*[\d-]+\s*/, "").trim();
}

/** Owner-digest line for the trailing week's blitz activity; silent when idle. */
export function buildBlitzLine(stats: {
  blitzes: number; spendCents: number; mobilizationLeads: number;
  blitzedJobs12mo: number; mobilizationRoofs12mo: number;
}, targetRoofsPerJobs = 7): string | null {
  if (stats.blitzes <= 0 && stats.mobilizationLeads <= 0) return null;
  const usd = (stats.spendCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const ratio = stats.mobilizationRoofs12mo > 0
    ? `1 roof per ${Math.round(stats.blitzedJobs12mo / stats.mobilizationRoofs12mo)} jobs`
    : "no roofs yet";
  return `Blitz: ${stats.blitzes} this week (${usd}), ${stats.mobilizationLeads} lead${stats.mobilizationLeads === 1 ? "" : "s"} — ${ratio} (target 1-in-${targetRoofsPerJobs})`;
}
