import { adminDb, withTenant, tenant, lead, property, eq, and, inArray, recordAgentRun, getScoringSettings } from "@savvy/db";
import { scoreLead, deriveLane, parseScoringConfig, buildLeadFeatures, tenantsDueAtHour } from "@savvy/core";
import { stormProof } from "@savvy/integrations";
import { inngest } from "../client";

const OPEN = ["new", "contacted", "qualified", "booked"] as const;

// Re-score one tenant's open leads; returns how many were upgraded to a higher band.
export async function rescoreTenant(tenantId: string): Promise<number> {
  const cfg = parseScoringConfig(await getScoringSettings(tenantId));
  const upgraded = await withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: lead.id, band: lead.scoreBand, source: lead.source, state: property.state,
        roofType: property.roofType, yearBuilt: property.yearBuilt, lat: property.lat, lng: property.lng,
        roofTypeSecondary: property.roofTypeSecondary, lastRoofReplacementAt: property.lastRoofReplacementAt,
      })
      .from(lead)
      .leftJoin(property, eq(lead.propertyId, property.id))
      .where(and(eq(lead.tenantId, tenantId), inArray(lead.status, [...OPEN])));

    let upgradedCount = 0;
    for (const r of rows) {
      if (r.lat == null || r.lng == null) continue;
      let storm;
      try {
        storm = await stormProof.lookupStorms({ lat: Number(r.lat), lng: Number(r.lng) });
      } catch (err) {
        console.error(`rescore: storm lookup failed for lead ${r.id}:`, err instanceof Error ? err.message : err);
        continue; // fail-open per lead
      }
      const features = buildLeadFeatures({
        source: r.source ?? "web", state: r.state, roofType: r.roofType, yearBuilt: r.yearBuilt,
        roofTypeSecondary: r.roofTypeSecondary, lastRoofReplacementAt: r.lastRoofReplacementAt,
        storm: { eventCount: storm.eventCount, maxHailInches: storm.maxHailInches, maxWindMph: storm.maxWindMph, daysSinceWorst: storm.daysSinceWorst },
      });
      const scored = scoreLead(features, cfg);
      const lane = deriveLane(features, cfg);
      const improved = bandRank(scored.band) > bandRank(r.band);
      await tx.update(lead).set({
        score: scored.score, scoreBand: scored.band, scoreReason: scored.reasons.join("; "), lane,
        scoreFeatures: { reasons: scored.reasons, components: scored.components },
      }).where(eq(lead.id, r.id));
      if (improved) upgradedCount++;
    }
    return upgradedCount;
  });
  // Audit the sweep AFTER the rescore tx closes — recordAgentRun opens its own
  // withTenant, so calling it inside would hold a second pooled connection (see lead-intake.ts).
  if (upgraded > 0) {
    await recordAgentRun({ tenantId, agent: "orchestrator", taskKey: "lead.rescore.upgraded", status: "ok" });
  }
  return upgraded;
}

function bandRank(b: string | null): number {
  return { cold: 0, cool: 1, warm: 2, hot: 3 }[b ?? "cold"] ?? 0;
}

export const leadRescore = inngest.createFunction(
  { id: "lead-rescore", concurrency: { limit: 1 } },
  { cron: "0 * * * *" }, // hourly tick; runs each tenant at 03:00 its local time
  async ({ step }) => {
    const due = await step.run("due-tenants", async () => {
      const rows = await adminDb.select({ id: tenant.id, timezone: tenant.timezone }).from(tenant);
      return tenantsDueAtHour(rows, new Date(), 3).map((t) => t.id);
    });
    let upgraded = 0;
    for (const id of due) {
      upgraded += await step.run(`rescore-${id}`, () => rescoreTenant(id));
    }
    return { upgraded };
  },
);
