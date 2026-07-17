import { z } from "zod";

// Phase 26 slice 5 — slow-week fill loop (spec: docs/superpowers/specs/
// prompts-phase26-margin-market.md). Capacity look-ahead emits a crew-gap
// signal when a hole opens inside gapLookaheadDays; every gap gets a fill
// plan or a logged pass. All thresholds are Library config, not code.

const slowWeekFillConfigSchema = z.object({
  enabled: z.boolean().catch(true).default(true),
  gapLookaheadDays: z.number().int().min(1).catch(10).default(10),
  minUtilizationPct: z.number().int().min(1).max(100).catch(60).default(60),
  agingEstimateDays: z.number().int().min(1).catch(7).default(7),
  // This-week incentive on aging unaccepted estimates. The margin floor is
  // re-checked on DISCOUNTED totals; over maxAutoDiscountBps ⇒ approval card.
  discountBps: z.number().int().min(0).catch(500).default(500),
  maxAutoDiscountBps: z.number().int().min(0).catch(1000).default(1000),
});
export type SlowWeekFillConfig = z.infer<typeof slowWeekFillConfigSchema>;

const FILL_DEFAULTS: SlowWeekFillConfig = {
  enabled: true, gapLookaheadDays: 10, minUtilizationPct: 60,
  agingEstimateDays: 7, discountBps: 500, maxAutoDiscountBps: 1000,
};

export function parseSlowWeekFillConfig(raw: unknown): SlowWeekFillConfig {
  const r = slowWeekFillConfigSchema.safeParse(raw ?? {});
  return r.success ? r.data : FILL_DEFAULTS;
}

/** Owner-digest line for the trailing week's fill-loop activity; silent when idle. */
export function buildFillLine(stats: {
  gaps: number; playsSent: number; conversions: number;
  idleCrewDaysRecovered: number; pendingCards: number;
}): string | null {
  if (stats.gaps <= 0 && stats.playsSent <= 0) return null;
  const parts = [
    `Fill: ${stats.gaps} gap${stats.gaps === 1 ? "" : "s"}`,
    `${stats.playsSent} play${stats.playsSent === 1 ? "" : "s"}`,
    `${stats.conversions} converted`,
    `${stats.idleCrewDaysRecovered} crew-day${stats.idleCrewDaysRecovered === 1 ? "" : "s"} recovered`,
  ];
  if (stats.pendingCards > 0) parts.push(`${stats.pendingCards} discount card${stats.pendingCards === 1 ? "" : "s"} pending`);
  return parts.join(", ");
}
