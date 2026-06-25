import { adminDb, withTenant, tenant, lead, property, eq, and, inArray, recordAgentRun, getScoringSettings } from "@savvy/db";
import { scoreLead, deriveLane, parseScoringConfig, buildLeadFeatures } from "@savvy/core";
import { stormProof } from "@savvy/integrations";
import { inngest } from "../client";

const OPEN = ["new", "contacted", "qualified", "booked"] as const;

// Re-score one tenant's open leads; returns how many were upgraded to a higher band.
export async function rescoreTenant(tenantId: string): Promise<number> {
  const cfg = parseScoringConfig(await getScoringSettings(tenantId));
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: lead.id, band: lead.scoreBand, source: lead.source, state: property.state,
        roofType: property.roofType, yearBuilt: property.yearBuilt, lat: property.lat, lng: property.lng,
      })
      .from(lead)
      .leftJoin(property, eq(lead.propertyId, property.id))
      .where(and(eq(lead.tenantId, tenantId), inArray(lead.status, [...OPEN])));

    let upgraded = 0;
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
        storm: { eventCount: storm.eventCount, maxHailInches: storm.maxHailInches, maxWindMph: storm.maxWindMph, daysSinceWorst: storm.daysSinceWorst },
      });
      const scored = scoreLead(features, cfg);
      const lane = deriveLane(features, cfg);
      const improved = bandRank(scored.band) > bandRank(r.band);
      await tx.update(lead).set({ score: scored.score, scoreBand: scored.band, scoreReason: scored.reasons.join("; "), lane }).where(eq(lead.id, r.id));
      if (improved) upgraded++;
    }
    // Audit the sweep (no per-user push channel exists yet; band lives on the lead for the UI).
    if (upgraded > 0) {
      await recordAgentRun({ tenantId, agent: "orchestrator", taskKey: "lead.rescore.upgraded", status: "ok" });
    }
    return upgraded;
  });
}

function bandRank(b: string | null): number {
  return { cold: 0, cool: 1, warm: 2, hot: 3 }[b ?? "cold"] ?? 0;
}

export const leadRescore = inngest.createFunction(
  { id: "lead-rescore", concurrency: { limit: 1 } },
  { cron: "TZ=America/Phoenix 0 3 * * *" }, // nightly 03:00
  async ({ step }) => {
    const tenants = await step.run("list-tenants", async () => adminDb.select({ id: tenant.id }).from(tenant));
    let upgraded = 0;
    for (const t of tenants) {
      upgraded += await step.run(`rescore-${t.id}`, () => rescoreTenant(t.id));
    }
    return { upgraded };
  },
);
