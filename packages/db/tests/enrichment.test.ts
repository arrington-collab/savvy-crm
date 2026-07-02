import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTenant } from "../src/tenant.js";
import { property, enrichmentAttempt } from "../src/schema/index.js";
import {
  recordEnrichmentAttempt,
  findPropertiesNeedingGeocode,
  findPropertiesNeedingStormproof,
} from "../src/lifecycle/enrichment.js";
import { makeTenant, makeJobWithProperty } from "./helpers.js";

describe("recordEnrichmentAttempt", () => {
  it("inserts then increments attempts on the same (entity, enricher)", async () => {
    const { tenantId } = await makeTenant();
    const entityId = crypto.randomUUID();
    await recordEnrichmentAttempt(tenantId, { entityType: "property", entityId, enricherKey: "geocode", status: "no_data" });
    await recordEnrichmentAttempt(tenantId, { entityType: "property", entityId, enricherKey: "geocode", status: "filled", detail: "ok" });
    const rows = await withTenant(tenantId, (tx) =>
      tx.select().from(enrichmentAttempt).where(eq(enrichmentAttempt.entityId, entityId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attempts).toBe(2);
    expect(rows[0]!.status).toBe("filled");
  });
});

describe("findPropertiesNeedingGeocode", () => {
  it("returns a property with null lat/lng", async () => {
    const { tenantId } = await makeTenant();
    const { propertyId } = await makeJobWithProperty(tenantId);
    const due = await findPropertiesNeedingGeocode(tenantId, 50);
    expect(due.map((d) => d.propertyId)).toContain(propertyId);
  });

  it("excludes a property that already has coordinates", async () => {
    const { tenantId } = await makeTenant();
    const { propertyId } = await makeJobWithProperty(tenantId);
    await withTenant(tenantId, (tx) => tx.update(property).set({ lat: 33.4, lng: -111.9 }).where(eq(property.id, propertyId)));
    const due = await findPropertiesNeedingGeocode(tenantId, 50);
    expect(due.map((d) => d.propertyId)).not.toContain(propertyId);
  });

  it("excludes a property attempted just now (backoff), includes one attempted long ago", async () => {
    const { tenantId } = await makeTenant();
    const { propertyId } = await makeJobWithProperty(tenantId);
    await recordEnrichmentAttempt(tenantId, { entityType: "property", entityId: propertyId, enricherKey: "geocode", status: "no_data" });
    expect((await findPropertiesNeedingGeocode(tenantId, 50)).map((d) => d.propertyId)).not.toContain(propertyId);
    // age the attempt past the backoff window
    await withTenant(tenantId, (tx) =>
      tx.update(enrichmentAttempt).set({ lastAttemptAt: new Date(Date.now() - 30 * 86_400_000) }).where(eq(enrichmentAttempt.entityId, propertyId)));
    expect((await findPropertiesNeedingGeocode(tenantId, 50)).map((d) => d.propertyId)).toContain(propertyId);
  });

  it("excludes a property that hit the attempt cap", async () => {
    const { tenantId } = await makeTenant();
    const { propertyId } = await makeJobWithProperty(tenantId);
    for (let i = 0; i < 3; i++)
      await recordEnrichmentAttempt(tenantId, { entityType: "property", entityId: propertyId, enricherKey: "geocode", status: "error" });
    await withTenant(tenantId, (tx) =>
      tx.update(enrichmentAttempt).set({ lastAttemptAt: new Date(Date.now() - 30 * 86_400_000) }).where(eq(enrichmentAttempt.entityId, propertyId)));
    expect((await findPropertiesNeedingGeocode(tenantId, 50)).map((d) => d.propertyId)).not.toContain(propertyId);
  });
});

describe("findPropertiesNeedingStormproof", () => {
  it("returns a property with coords but no year built; excludes one without coords", async () => {
    const { tenantId } = await makeTenant();
    const { propertyId: noCoords } = await makeJobWithProperty(tenantId);
    const { propertyId: withCoords } = await makeJobWithProperty(tenantId);
    await withTenant(tenantId, (tx) => tx.update(property).set({ lat: 1, lng: 2 }).where(eq(property.id, withCoords)));
    const ids = (await findPropertiesNeedingStormproof(tenantId, 50)).map((d) => d.propertyId);
    expect(ids).toContain(withCoords);
    expect(ids).not.toContain(noCoords);
  });
});

describe("enrichment ledger RLS", () => {
  it("does not leak another tenant's attempts", async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const eid = crypto.randomUUID();
    await recordEnrichmentAttempt(b.tenantId, { entityType: "property", entityId: eid, enricherKey: "geocode", status: "filled" });
    const rows = await withTenant(a.tenantId, (tx) => tx.select().from(enrichmentAttempt));
    expect(rows.find((r) => r.entityId === eid)).toBeUndefined();
  });
});
