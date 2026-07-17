import { describe, it, expect } from "vitest";
import { adminDb, tenant, property, spotterPin, and, eq, isNull, setPropertyRoofMaterial } from "@savvy/db";
import { makeFakeSpotterFeed, type SpotterPin } from "@savvy/integrations";
import { importSpotterPins } from "./spotter-import.js";

const pin = (o: Partial<SpotterPin> & { externalId: string }): SpotterPin => ({
  lat: 33.45, lng: -112.07, materialTag: "wood_shake", hasDebris: false,
  spotterName: "Dana", taggedAt: new Date("2026-07-10T00:00:00Z"), address: null, ...o,
});

async function makeTenant() {
  const [t] = await adminDb.insert(tenant).values({
    name: "SpotterCo", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`,
  }).returning();
  return t!.id;
}

async function seedProperty(tenantId: string, o: { address: string; lat?: number; lng?: number }) {
  const [p] = await adminDb.insert(property).values({ tenantId, ...o }).returning();
  return p!.id;
}

async function readProp(id: string) {
  const [p] = await adminDb.select().from(property).where(eq(property.id, id));
  return p!;
}

describe("importSpotterPins", () => {
  it("matches a property by address and writes roof_material with source=spotter", async () => {
    const tenantId = await makeTenant();
    const propId = await seedProperty(tenantId, { address: "5 Shake St", lat: 33.45, lng: -112.07 });
    const feed = makeFakeSpotterFeed([pin({ externalId: "T1", address: "5 SHAKE ST" })]);

    const res = await importSpotterPins(tenantId, { feed });
    expect(res).toMatchObject({ matched: 1, created: 0 });

    const p = await readProp(propId);
    expect(p.roofMaterial).toBe("wood_shake");
    expect(p.roofMaterialSource).toBe("spotter");

    const [row] = await adminDb.select().from(spotterPin).where(eq(spotterPin.tenantId, tenantId));
    expect(row!.matchedPropertyId).toBe(propId);
    expect(row!.syncedAt).not.toBeNull();
  });

  it("matches the nearest property by geo when the pin has no address", async () => {
    const tenantId = await makeTenant();
    const propId = await seedProperty(tenantId, { address: "Somewhere", lat: 33.4500, lng: -112.0700 });
    const feed = makeFakeSpotterFeed([pin({ externalId: "T2", lat: 33.45005, lng: -112.07, materialTag: "clay_tile" })]);

    await importSpotterPins(tenantId, { feed });
    expect((await readProp(propId)).roofMaterial).toBe("clay_tile");
  });

  it("creates a prospect property (no customer) for a pin that matches nothing", async () => {
    const tenantId = await makeTenant();
    const feed = makeFakeSpotterFeed([pin({ externalId: "T3", lat: 34.9, lng: -110.0 })]);

    const res = await importSpotterPins(tenantId, { feed });
    expect(res).toMatchObject({ matched: 0, created: 1 });

    const [prospect] = await adminDb.select().from(property)
      .where(and(eq(property.tenantId, tenantId), isNull(property.customerId)));
    expect(prospect!.roofMaterial).toBe("wood_shake");
    expect(prospect!.roofMaterialSource).toBe("spotter");
    expect(prospect!.lat).toBe(34.9);
  });

  it("is idempotent — a re-sync updates the pin in place and creates no duplicate property", async () => {
    const tenantId = await makeTenant();
    const feed = makeFakeSpotterFeed([pin({ externalId: "T4", lat: 34.9, lng: -110.0 })]);

    await importSpotterPins(tenantId, { feed });
    const second = await importSpotterPins(tenantId, { feed });
    expect(second).toMatchObject({ matched: 1, created: 0 });

    expect((await adminDb.select().from(property).where(eq(property.tenantId, tenantId)))).toHaveLength(1);
    expect((await adminDb.select().from(spotterPin).where(eq(spotterPin.tenantId, tenantId)))).toHaveLength(1);
  });

  it("PRECEDENCE: a spotter pin upgrades an assessor guess but never overwrites an inspection", async () => {
    const tenantId = await makeTenant();
    const assessorProp = await seedProperty(tenantId, { address: "10 Assessor Ave", lat: 33.4, lng: -112.0 });
    const inspProp = await seedProperty(tenantId, { address: "20 Inspected Blvd", lat: 33.5, lng: -112.2 });
    await setPropertyRoofMaterial(tenantId, { propertyId: assessorProp, material: "asphalt_shingle", source: "assessor" });
    await setPropertyRoofMaterial(tenantId, { propertyId: inspProp, material: "clay_tile", source: "inspection" });

    const feed = makeFakeSpotterFeed([
      pin({ externalId: "UP", address: "10 ASSESSOR AVE", materialTag: "wood_shake" }),
      pin({ externalId: "KEEP", address: "20 INSPECTED BLVD", materialTag: "metal" }),
    ]);
    await importSpotterPins(tenantId, { feed });

    expect((await readProp(assessorProp)).roofMaterial).toBe("wood_shake"); // spotter > assessor
    expect((await readProp(assessorProp)).roofMaterialSource).toBe("spotter");
    expect((await readProp(inspProp)).roofMaterial).toBe("clay_tile"); // inspection stands
    expect((await readProp(inspProp)).roofMaterialSource).toBe("inspection");
  });
});
