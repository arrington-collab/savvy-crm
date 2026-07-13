// Background Ops enrichment engine: an ordered set of enrichers the nightly sweep
// runs per tenant. Each enricher knows which records are "due" (gap present + not
// recently attempted, via the enrichment_attempt ledger) and how to fill one.
import {
  withTenant,
  property,
  lead,
  eq,
  recordEnrichmentAttempt,
  findPropertiesNeedingGeocode,
  findPropertiesNeedingStormproof,
  findLeadIdForProperty,
  recordAgentRun,
  withAgentRun,
  type PropertyDue,
} from "@savvy/db";
import { geocode as defaultGeocode, stormProof as defaultStormProof, type StormProofGateway } from "@savvy/integrations";
import { enrichProperty } from "./functions/lead-intake";

export type EnrichOutcome = "filled" | "no_data" | "error";

export interface Enricher {
  key: string;
  findDue(tenantId: string, limit: number): Promise<PropertyDue[]>;
  run(tenantId: string, ref: PropertyDue): Promise<EnrichOutcome>;
}

// Attribute the work to the property's lead so it shows in the command-center feed
// WITH the customer name (reuses the agent_run.lead_id added in #80).
async function attribute(tenantId: string, propertyId: string, taskKey: string): Promise<void> {
  const leadId = await findLeadIdForProperty(tenantId, propertyId);
  await recordAgentRun({ tenantId, leadId, agent: "orchestrator", taskKey, status: "ok" });
}

export function makeGeocodeEnricher(geocodeImpl: typeof defaultGeocode = defaultGeocode): Enricher {
  return {
    key: "geocode",
    findDue: (t, l) => findPropertiesNeedingGeocode(t, l),
    async run(tenantId, ref) {
      try {
        const pt = await geocodeImpl(ref.address);
        if (!pt) {
          await recordEnrichmentAttempt(tenantId, { entityType: "property", entityId: ref.propertyId, enricherKey: "geocode", status: "no_data" });
          return "no_data";
        }
        await withTenant(tenantId, (tx) => tx.update(property).set({ lat: pt.lat, lng: pt.lng }).where(eq(property.id, ref.propertyId)));
        await recordEnrichmentAttempt(tenantId, { entityType: "property", entityId: ref.propertyId, enricherKey: "geocode", status: "filled" });
        await attribute(tenantId, ref.propertyId, "enrich.geocode");
        return "filled";
      } catch (e) {
        await recordEnrichmentAttempt(tenantId, { entityType: "property", entityId: ref.propertyId, enricherKey: "geocode", status: "error", detail: e instanceof Error ? e.message : "error" });
        return "error";
      }
    },
  };
}

export function makeStormproofEnricher(sp: StormProofGateway = defaultStormProof): Enricher {
  return {
    key: "property-stormproof",
    findDue: (t, l) => findPropertiesNeedingStormproof(t, l),
    async run(tenantId, ref) {
      try {
        const [p] = await withTenant(tenantId, (tx) => tx.select().from(property).where(eq(property.id, ref.propertyId)));
        if (!p) return "error";
        const leadId = await findLeadIdForProperty(tenantId, ref.propertyId);
        const result = await withAgentRun({ tenantId, leadId, agent: "orchestrator", taskKey: "enrich.property" }, async () => {
          const enriched = await enrichProperty(
            { lat: p.lat ?? null, lng: p.lng ?? null, address: p.address, yearBuilt: p.yearBuilt ?? null, roofType: p.roofType ?? null, county: p.county ?? null },
            sp,
          );
          await withTenant(tenantId, async (tx) => {
            await tx.update(property).set({ yearBuilt: enriched.yearBuilt, roofType: enriched.roofType, county: enriched.county }).where(eq(property.id, ref.propertyId));
            if (leadId) await tx.update(lead).set({ stormEventId: enriched.stormEventId }).where(eq(lead.id, leadId));
          });
          return enriched;
        });
        const filled = result.yearBuilt != null;
        await recordEnrichmentAttempt(tenantId, { entityType: "property", entityId: ref.propertyId, enricherKey: "property-stormproof", status: filled ? "filled" : "no_data" });
        return filled ? "filled" : "no_data";
      } catch (e) {
        await recordEnrichmentAttempt(tenantId, { entityType: "property", entityId: ref.propertyId, enricherKey: "property-stormproof", status: "error", detail: e instanceof Error ? e.message : "error" });
        return "error";
      }
    },
  };
}

/** Ordered: geocode first so a freshly-geocoded property is stormproof-eligible same pass. */
export const ENRICHERS: Enricher[] = [makeGeocodeEnricher(), makeStormproofEnricher()];

export type SweepResult = Record<string, { due: number; filled: number }>;

export async function sweepTenant(tenantId: string, enrichers: Enricher[] = ENRICHERS, limit = 25): Promise<SweepResult> {
  const out: SweepResult = {};
  for (const e of enrichers) {
    const due = await e.findDue(tenantId, limit);
    let filled = 0;
    for (const ref of due) {
      if ((await e.run(tenantId, ref)) === "filled") filled++;
    }
    out[e.key] = { due: due.length, filled };
  }
  return out;
}
