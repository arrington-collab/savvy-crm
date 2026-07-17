import { describe, it, expect } from "vitest";
import { adminDb } from "../src/admin-client";
import { property } from "../src/schema/crm";
import { spotterPin } from "../src/schema/strike-list";
import { spotterPrecisionReport } from "../src/lifecycle/spotter-precision";
import { makeTenant } from "./helpers";

async function inspectedProperty(tenantId: string, material: string) {
  const [p] = await adminDb.insert(property).values({
    tenantId, address: `${material} house`, roofMaterial: material, roofMaterialSource: "inspection",
  }).returning();
  return p!.id;
}

async function pin(tenantId: string, o: { spotter: string; tag: string; propId: string | null }) {
  await adminDb.insert(spotterPin).values({
    tenantId, externalId: `ext-${crypto.randomUUID()}`, lat: 33.4, lng: -112.0,
    materialTag: o.tag, spotterName: o.spotter, matchedPropertyId: o.propId,
  });
}

describe("spotterPrecisionReport (#266)", () => {
  it("scores each spotter against inspection ground truth, ignoring un-inspected matches", async () => {
    const { tenantId } = await makeTenant();
    const shakeHouse = await inspectedProperty(tenantId, "wood_shake");
    const tileHouse = await inspectedProperty(tenantId, "clay_tile");

    // Dana: 1 right (shake), 1 wrong (called it metal, inspection says clay).
    await pin(tenantId, { spotter: "Dana", tag: "wood_shake", propId: shakeHouse });
    await pin(tenantId, { spotter: "Dana", tag: "metal", propId: tileHouse });
    // A pin matched to a property with no inspection yet → no ground truth, excluded.
    const [uninspected] = await adminDb.insert(property).values({
      tenantId, address: "no truth yet", roofMaterial: "concrete_tile", roofMaterialSource: "spotter",
    }).returning();
    await pin(tenantId, { spotter: "Dana", tag: "concrete_tile", propId: uninspected!.id });

    const report = await spotterPrecisionReport(tenantId);
    const dana = report.find((r) => r.spotterName === "Dana")!;
    expect(dana.samples).toBe(2); // the un-inspected match is excluded
    expect(dana.correct).toBe(1);
    expect(dana.precision).toBeCloseTo(0.5);
  });

  it("returns a row per spotter", async () => {
    const { tenantId } = await makeTenant();
    const shakeHouse = await inspectedProperty(tenantId, "wood_shake");
    await pin(tenantId, { spotter: "Dana", tag: "wood_shake", propId: shakeHouse });
    await pin(tenantId, { spotter: "Lee", tag: "metal", propId: shakeHouse });

    const report = await spotterPrecisionReport(tenantId);
    expect(report.map((r) => r.spotterName).sort()).toEqual(["Dana", "Lee"]);
  });
});
