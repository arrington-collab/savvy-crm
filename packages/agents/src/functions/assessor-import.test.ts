import { describe, it, expect } from "vitest";
import { adminDb, tenant, property, and, eq, isNull, setPropertyRoofMaterial } from "@savvy/db";
import { makeFakeAssessorFeed, type AssessorParcel } from "@savvy/integrations";
import { importAssessorParcels } from "./assessor-import.js";

const parcel = (o: Partial<AssessorParcel> & { parcelId: string; address: string }): AssessorParcel => ({
  roofMaterial: "wood_shake", yearBuilt: 1995, subdivision: "Sun Ridge", ...o,
});

async function makeTenant() {
  const [t] = await adminDb.insert(tenant).values({
    name: "AssessorCo", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`,
  }).returning();
  return t!.id;
}

async function seedProperty(tenantId: string, address: string) {
  const [p] = await adminDb.insert(property).values({ tenantId, address }).returning();
  return p!.id;
}

async function readProp(id: string) {
  const [p] = await adminDb.select().from(property).where(eq(property.id, id));
  return p!;
}

describe("importAssessorParcels", () => {
  it("matches an existing property by normalized address and upgrades material + subdivision + parcel", async () => {
    const tenantId = await makeTenant();
    const propId = await seedProperty(tenantId, "742 Evergreen Ter");
    const feed = makeFakeAssessorFeed([parcel({ parcelId: "123-45-678", address: "  742 EVERGREEN TER " })]);

    const res = await importAssessorParcels(tenantId, { feed, county: "maricopa" });
    expect(res).toMatchObject({ matched: 1, created: 0, excluded: 0 });

    const p = await readProp(propId);
    expect(p.roofMaterial).toBe("wood_shake");
    expect(p.roofMaterialSource).toBe("assessor");
    expect(p.subdivision).toBe("Sun Ridge");
    expect(p.parcelId).toBe("123-45-678");
    expect(p.yearBuilt).toBe(1995);
  });

  it("creates a prospect property (no customer) for an unmatched parcel", async () => {
    const tenantId = await makeTenant();
    const feed = makeFakeAssessorFeed([parcel({ parcelId: "999", address: "88 Prospect Way" })]);

    const res = await importAssessorParcels(tenantId, { feed, county: "maricopa" });
    expect(res).toMatchObject({ matched: 0, created: 1 });

    const [prospect] = await adminDb.select().from(property)
      .where(and(eq(property.tenantId, tenantId), isNull(property.customerId)));
    expect(prospect!.address).toBe("88 Prospect Way");
    expect(prospect!.roofMaterial).toBe("wood_shake");
    expect(prospect!.roofMaterialSource).toBe("assessor");
    expect(prospect!.parcelId).toBe("999");
  });

  it("is idempotent — a re-import matches the prospect by parcel id and creates no duplicate", async () => {
    const tenantId = await makeTenant();
    const feed = makeFakeAssessorFeed([parcel({ parcelId: "555", address: "5 Repeat Rd" })]);

    await importAssessorParcels(tenantId, { feed, county: "maricopa" });
    const second = await importAssessorParcels(tenantId, { feed, county: "maricopa" });
    expect(second).toMatchObject({ matched: 1, created: 0 });

    const rows = await adminDb.select().from(property).where(eq(property.tenantId, tenantId));
    expect(rows).toHaveLength(1);
  });

  it("PRECEDENCE: an assessor import never overwrites an inspection-sourced material (but still fills parcel/subdivision)", async () => {
    const tenantId = await makeTenant();
    const propId = await seedProperty(tenantId, "1 Inspected Ln");
    await setPropertyRoofMaterial(tenantId, { propertyId: propId, material: "clay_tile", source: "inspection" });
    const feed = makeFakeAssessorFeed([parcel({ parcelId: "INSP-1", address: "1 Inspected Ln", roofMaterial: "asphalt_shingle" })]);

    await importAssessorParcels(tenantId, { feed, county: "maricopa" });
    const p = await readProp(propId);
    expect(p.roofMaterial).toBe("clay_tile"); // inspection stands
    expect(p.roofMaterialSource).toBe("inspection");
    expect(p.parcelId).toBe("INSP-1"); // metadata still filled
    expect(p.subdivision).toBe("Sun Ridge");
  });

  it("subtracts re-roofed parcels — a re-roofed parcel is neither matched nor created", async () => {
    const tenantId = await makeTenant();
    const feed = makeFakeAssessorFeed([parcel({ parcelId: "REROOF-1", address: "7 New Roof Ct" })]);

    const res = await importAssessorParcels(tenantId, {
      feed, county: "maricopa", reRoofedParcelIds: new Set(["REROOF-1"]),
    });
    expect(res).toMatchObject({ matched: 0, created: 0, excluded: 1 });
    const rows = await adminDb.select().from(property).where(eq(property.tenantId, tenantId));
    expect(rows).toHaveLength(0);
  });
});
