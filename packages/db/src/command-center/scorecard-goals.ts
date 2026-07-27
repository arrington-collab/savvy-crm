import { and, eq, isNull } from "drizzle-orm";
import type { GoalConfig } from "@savvy/command-center";
import { withTenant } from "../tenant";
import { scorecardGoal } from "../schema/scorecard";

// D4-6: EOS scorecard goals (spec "Goals" / A.2). `scorecard_goal` is the
// configurable source of truth; DEFAULT_GOALS below are PLACEHOLDER values
// ONLY — sensible-shaped numbers so on/off-track renders something
// meaningful before Brett/Scott set real EOS targets. They are NOT a
// business commitment and must never be treated as one; every entry carries
// `isPlaceholder: true` so the UI (D4-7) can render "goal: placeholder"
// instead of presenting a guess as authoritative.
export const DEFAULT_GOALS: Record<string, GoalConfig> = {
  "leads.new": { target: 20, direction: "gte", isPlaceholder: true },
  // 300s = 5 min, matching the SLA_SECONDS constant weekly.ts re-derives from.
  "speed.median_seconds": { target: 300, direction: "lte", isPlaceholder: true },
  "speed.pct_under_sla": { target: 0.9, direction: "gte", isPlaceholder: true },
  "appts.set": { target: 15, direction: "gte", isPlaceholder: true },
  "appts.no_show_rate": { target: 0.15, direction: "lte", isPlaceholder: true },
  "contracts.count": { target: 5, direction: "gte", isPlaceholder: true },
  "contracts.value": { target: 5_000_000, direction: "gte", isPlaceholder: true }, // $50,000
  "close_rate.cohort": { target: 0.3, direction: "gte", isPlaceholder: true },
  "close_rate.activity": { target: 0.3, direction: "gte", isPlaceholder: true },
  "revenue.invoiced": { target: 5_000_000, direction: "gte", isPlaceholder: true },
  "cash.collected": { target: 4_000_000, direction: "gte", isPlaceholder: true },
  // marginPct is stored as a 0-100 number elsewhere (estimate.approved payload), not a 0-1 fraction.
  "margin.avg_pct": { target: 35, direction: "gte", isPlaceholder: true },
  "reviews.count": { target: 3, direction: "gte", isPlaceholder: true },
  "reviews.avg_stars": { target: 4.5, direction: "gte", isPlaceholder: true },
  "exceptions.open": { target: 5, direction: "lte", isPlaceholder: true },
};

/**
 * Reads configured goals for `(tenantId, locationId)` from `scorecard_goal`,
 * falling back to `DEFAULT_GOALS` for any metricKey with no row.
 * `locationId` omitted/null = company-wide goals (the `NULLS NOT DISTINCT`
 * unique index's null bucket — see schema/scorecard.ts).
 */
export async function getGoals(tenantId: string, locationId?: string | null): Promise<Record<string, GoalConfig>> {
  const loc = locationId ?? null;
  const rows = await withTenant(tenantId, (tx) =>
    tx.select().from(scorecardGoal).where(and(
      eq(scorecardGoal.tenantId, tenantId),
      loc === null ? isNull(scorecardGoal.locationId) : eq(scorecardGoal.locationId, loc),
    )));

  const goals: Record<string, GoalConfig> = { ...DEFAULT_GOALS };
  for (const r of rows) {
    goals[r.metricKey] = { target: r.target, direction: r.direction as "gte" | "lte", isPlaceholder: r.isPlaceholder };
  }
  return goals;
}

/**
 * Idempotent seeder: inserts every `DEFAULT_GOALS` entry for
 * `(tenantId, locationId)`, doing nothing on conflict — so re-running it
 * never overwrites a real target Brett/Scott have since configured; it only
 * fills gaps for metricKeys that have no row at all yet.
 */
export async function seedPlaceholderGoals(tenantId: string, locationId?: string | null): Promise<void> {
  const loc = locationId ?? null;
  await withTenant(tenantId, async (tx) => {
    for (const [metricKey, g] of Object.entries(DEFAULT_GOALS)) {
      await tx.insert(scorecardGoal)
        .values({ tenantId, locationId: loc, metricKey, target: g.target, direction: g.direction, isPlaceholder: true })
        .onConflictDoNothing({ target: [scorecardGoal.tenantId, scorecardGoal.locationId, scorecardGoal.metricKey] });
    }
  });
}
