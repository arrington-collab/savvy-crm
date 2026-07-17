import { z } from "zod";

// Phase 26 slice 5 — slow-week fill loop (spec: docs/superpowers/specs/
// prompts-phase26-margin-market.md). Capacity look-ahead emits a crew-gap
// signal when a hole opens inside gapLookaheadDays; every gap gets a fill
// plan or a logged pass. All thresholds are Library config, not code.

const FILL_COPY = {
  discount: "Hi {{firstName}} — we have a crew in your area this week and can offer special pricing on your estimate if you schedule now. Interested?",
  repair: "Hi {{firstName}} — we have an opening this week and can get your roof repair scheduled. Want us to lock in a day?",
} as const;

const slowWeekFillConfigSchema = z.object({
  enabled: z.boolean().catch(true).default(true),
  gapLookaheadDays: z.number().int().min(1).catch(10).default(10),
  minUtilizationPct: z.number().int().min(1).max(100).catch(60).default(60),
  agingEstimateDays: z.number().int().min(1).catch(7).default(7),
  // This-week incentive on aging unaccepted estimates. The margin floor is
  // re-checked on DISCOUNTED totals; over maxAutoDiscountBps ⇒ approval card.
  discountBps: z.number().int().min(0).catch(500).default(500),
  maxAutoDiscountBps: z.number().int().min(0).catch(1000).default(1000),
  // Fallback offer copy (Library; a messageTemplate row overrides these).
  copy: z.object({
    discount: z.string().catch(FILL_COPY.discount).default(FILL_COPY.discount),
    repair: z.string().catch(FILL_COPY.repair).default(FILL_COPY.repair),
  }).catch({ ...FILL_COPY }).default({ ...FILL_COPY }),
});
export type SlowWeekFillConfig = z.infer<typeof slowWeekFillConfigSchema>;

const FILL_DEFAULTS: SlowWeekFillConfig = {
  enabled: true, gapLookaheadDays: 10, minUtilizationPct: 60,
  agingEstimateDays: 7, discountBps: 500, maxAutoDiscountBps: 1000,
  copy: { ...FILL_COPY },
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
