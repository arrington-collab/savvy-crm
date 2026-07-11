import { describe, it, expect } from "vitest";
import { adminDb, withTenant, tenant, customer, property, lead, agentRun, eq, and } from "@savvy/db";
import { makeFakeStormProof, type GeoPoint } from "@savvy/integrations";
import { makeGeocodeEnricher, makeStormproofEnricher, sweepTenant } from "./enrichment";

async function seed(): Promise<{ tenantId: string; propertyId: string; leadId: string }> {
  const [t] = await adminDb
    .insert(tenant)
    .values({ name: "EnrichTest", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}` })
    .returning();
  const [c] = await adminDb.insert(customer).values({ tenantId: t!.id, name: "Test Customer" }).returning();
  const [p] = await adminDb
    .insert(property)
    .values({ tenantId: t!.id, customerId: c!.id, address: "882 W Elm St, Mesa AZ 85203" })
    .returning();
  const [l] = await adminDb
    .insert(lead)
    .values({ tenantId: t!.id, customerId: c!.id, propertyId: p!.id, source: "test" })
    .returning();
  return { tenantId: t!.id, propertyId: p!.id, leadId: l!.id };
}

const fakeGeo = (pt: GeoPoint | null) => (async (_addr: string) => pt) as typeof import("@savvy/integrations").geocode;

describe("enrichment sweep convergence", () => {
  it("geocodes a property, then storm-enriches it in the SAME sweep", async () => {
    const { tenantId, propertyId } = await seed();
    const enrichers = [makeGeocodeEnricher(fakeGeo({ lat: 33.42, lng: -111.83 })), makeStormproofEnricher(makeFakeStormProof())];
    const result = await sweepTenant(tenantId, enrichers, 50);

    const [p] = await withTenant(tenantId, (tx) => tx.select().from(property).where(eq(property.id, propertyId)));
    expect(p!.lat).toBeCloseTo(33.42);
    expect(p!.lng).toBeCloseTo(-111.83);
    expect(p!.yearBuilt).toBe(2004); // makeFakeStormProof getProperty
    expect(p!.county).toBe("Maricopa");
    expect(result.geocode!.filled).toBe(1);
    expect(result["property-stormproof"]!.filled).toBe(1);
  });

  it("attributes the stormproof run to the lead and records it ok via withAgentRun", async () => {
    const { tenantId, propertyId, leadId } = await seed();
    await withTenant(tenantId, (tx) => tx.update(property).set({ lat: 33.42, lng: -111.83 }).where(eq(property.id, propertyId)));
    const enricher = makeStormproofEnricher(makeFakeStormProof());
    const outcome = await enricher.run(tenantId, { propertyId, address: "882 W Elm St, Mesa AZ 85203" });
    expect(outcome).toBe("filled");

    const runs = await withTenant(tenantId, (tx) =>
      tx.select().from(agentRun).where(and(eq(agentRun.taskKey, "enrich.property"), eq(agentRun.leadId, leadId))),
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("ok");
    expect(runs[0]!.leadId).toBe(leadId);
  });

  it("records no_data and does NOT re-hammer next sweep (backoff)", async () => {
    const { tenantId } = await seed();
    const geo = makeGeocodeEnricher(fakeGeo(null));
    const r1 = await sweepTenant(tenantId, [geo], 50);
    expect(r1.geocode).toEqual({ due: 1, filled: 0 });
    const r2 = await sweepTenant(tenantId, [geo], 50);
    expect(r2.geocode!.due).toBe(0); // excluded by backoff — no API re-call
  });
});
