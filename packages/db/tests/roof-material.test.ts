import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "../src/admin-client";
import { property } from "../src/schema/crm";
import { setPropertyRoofMaterial, confirmPropertyRoofType } from "../src/lifecycle/roof-material";
import { makeTenant } from "./helpers";

async function makeProperty(tenantId: string, address = "1 Test St") {
  const [p] = await adminDb.insert(property).values({ tenantId, address }).returning();
  return p!.id;
}

async function readMaterial(propertyId: string) {
  const [p] = await adminDb.select({
    roofMaterial: property.roofMaterial,
    roofMaterialSource: property.roofMaterialSource,
    roofMaterialConfidence: property.roofMaterialConfidence,
  }).from(property).where(eq(property.id, propertyId));
  return p!;
}

describe("setPropertyRoofMaterial — the single precedence-guarded write path", () => {
  it("fills an empty value from any source", async () => {
    const { tenantId } = await makeTenant();
    const propertyId = await makeProperty(tenantId);

    const wrote = await setPropertyRoofMaterial(tenantId, {
      propertyId, material: "wood_shake", source: "assessor", confidence: 0.7,
    });
    expect(wrote).toBe(true);
    const p = await readMaterial(propertyId);
    expect(p.roofMaterial).toBe("wood_shake");
    expect(p.roofMaterialSource).toBe("assessor");
    expect(p.roofMaterialConfidence).toBe(0.7);
  });

  it("PRECEDENCE: an inspection-sourced material is never overwritten by an assessor import", async () => {
    const { tenantId } = await makeTenant();
    const propertyId = await makeProperty(tenantId);
    await setPropertyRoofMaterial(tenantId, { propertyId, material: "clay_tile", source: "inspection" });

    const wrote = await setPropertyRoofMaterial(tenantId, { propertyId, material: "asphalt_shingle", source: "assessor" });
    expect(wrote).toBe(false);
    expect((await readMaterial(propertyId)).roofMaterial).toBe("clay_tile"); // inspection stands
  });

  it("a higher-precedence source upgrades a lower one", async () => {
    const { tenantId } = await makeTenant();
    const propertyId = await makeProperty(tenantId);
    await setPropertyRoofMaterial(tenantId, { propertyId, material: "asphalt_shingle", source: "inference" });

    const wrote = await setPropertyRoofMaterial(tenantId, { propertyId, material: "wood_shake", source: "assessor" });
    expect(wrote).toBe(true);
    expect((await readMaterial(propertyId)).roofMaterial).toBe("wood_shake");
  });

  it("a same-source refresh updates in place (annual re-import)", async () => {
    const { tenantId } = await makeTenant();
    const propertyId = await makeProperty(tenantId);
    await setPropertyRoofMaterial(tenantId, { propertyId, material: "concrete_tile", source: "assessor", confidence: 0.5 });

    const wrote = await setPropertyRoofMaterial(tenantId, { propertyId, material: "clay_tile", source: "assessor", confidence: 0.9 });
    expect(wrote).toBe(true);
    const p = await readMaterial(propertyId);
    expect(p.roofMaterial).toBe("clay_tile");
    expect(p.roofMaterialConfidence).toBe(0.9);
  });
});

describe("confirmPropertyRoofType — human desk confirmation from the Today queue", () => {
  async function readTypeAndMaterial(propertyId: string) {
    const [p] = await adminDb.select({
      roofType: property.roofType,
      roofMaterial: property.roofMaterial,
      roofMaterialSource: property.roofMaterialSource,
    }).from(property).where(eq(property.id, propertyId));
    return p!;
  }

  it("writes the fine material AND the derived legacy roofType (clears roof_type_needed)", async () => {
    const { tenantId } = await makeTenant();
    const propertyId = await makeProperty(tenantId);

    const ok = await confirmPropertyRoofType(tenantId, { propertyId, material: "clay_tile" });
    expect(ok).toBe(true);
    const p = await readTypeAndMaterial(propertyId);
    expect(p.roofMaterial).toBe("clay_tile");        // fine value for Strike List targeting
    expect(p.roofMaterialSource).toBe("inspection"); // human = highest authority
    expect(p.roofType).toBe("tile");                 // legacy coarse — this is what the exception keys on
  });

  it("a human correction overrides an existing automated material", async () => {
    const { tenantId } = await makeTenant();
    const propertyId = await makeProperty(tenantId);
    await setPropertyRoofMaterial(tenantId, { propertyId, material: "asphalt_shingle", source: "assessor" });

    const ok = await confirmPropertyRoofType(tenantId, { propertyId, material: "metal" });
    expect(ok).toBe(true);
    const p = await readTypeAndMaterial(propertyId);
    expect(p.roofMaterial).toBe("metal");
    expect(p.roofType).toBe("metal");
  });

  it("returns false for a missing property", async () => {
    const { tenantId } = await makeTenant();
    expect(await confirmPropertyRoofType(tenantId, { propertyId: "00000000-0000-0000-0000-000000000000", material: "metal" })).toBe(false);
  });
});
