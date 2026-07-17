import { describe, it, expect } from "vitest";
import {
  ROOF_MATERIAL_VALUES,
  ROOF_MATERIAL_SOURCES,
  GOLDEN_ROOF_MATERIALS,
  isGoldenRoof,
  roofMaterialToRoofType,
  canUpgradeRoofMaterial,
} from "./roof-material";

describe("roof-material vocabulary", () => {
  it("covers the eight Strike List materials", () => {
    expect(ROOF_MATERIAL_VALUES).toEqual([
      "asphalt_shingle", "wood_shake", "clay_tile", "concrete_tile",
      "metal", "flat_builtup", "asbestos_suspect", "other",
    ]);
  });

  it("ranks the five sources", () => {
    expect(ROOF_MATERIAL_SOURCES).toEqual(["inspection", "spotter", "assessor", "cv_pilot", "inference"]);
  });

  it("golden roofs are the high-value targeting materials", () => {
    expect([...GOLDEN_ROOF_MATERIALS].sort()).toEqual(["asbestos_suspect", "clay_tile", "wood_shake"]);
    expect(isGoldenRoof("wood_shake")).toBe(true);
    expect(isGoldenRoof("asphalt_shingle")).toBe(false);
    expect(isGoldenRoof(null)).toBe(false);
  });
});

describe("roofMaterialToRoofType — reconcile with the legacy ROOF_TYPE_VALUES", () => {
  it("downcasts the finer materials onto the coarse roof types (no duplication)", () => {
    expect(roofMaterialToRoofType("asphalt_shingle")).toBe("asphalt_shingle");
    expect(roofMaterialToRoofType("clay_tile")).toBe("tile");
    expect(roofMaterialToRoofType("concrete_tile")).toBe("tile");
    expect(roofMaterialToRoofType("metal")).toBe("metal");
    expect(roofMaterialToRoofType("flat_builtup")).toBe("flat_foam");
    expect(roofMaterialToRoofType("wood_shake")).toBe("other");
    expect(roofMaterialToRoofType("asbestos_suspect")).toBe("other");
    expect(roofMaterialToRoofType("other")).toBe("other");
  });
});

describe("canUpgradeRoofMaterial — precedence ladder", () => {
  it("inspection is authoritative and is never overwritten", () => {
    expect(canUpgradeRoofMaterial("inspection", "spotter")).toBe(false);
    expect(canUpgradeRoofMaterial("inspection", "assessor")).toBe(false);
    expect(canUpgradeRoofMaterial("inspection", "inference")).toBe(false);
  });

  it("a higher-precedence source upgrades a lower one", () => {
    expect(canUpgradeRoofMaterial("assessor", "spotter")).toBe(true);
    expect(canUpgradeRoofMaterial("inference", "assessor")).toBe(true);
    expect(canUpgradeRoofMaterial("cv_pilot", "inspection")).toBe(true);
  });

  it("a lower-precedence source never downgrades a higher one", () => {
    expect(canUpgradeRoofMaterial("assessor", "inference")).toBe(false);
    expect(canUpgradeRoofMaterial("spotter", "cv_pilot")).toBe(false);
  });

  it("a same-source refresh is allowed (re-imports update in place)", () => {
    expect(canUpgradeRoofMaterial("assessor", "assessor")).toBe(true);
  });

  it("any source fills an empty (null) value", () => {
    expect(canUpgradeRoofMaterial(null, "inference")).toBe(true);
    expect(canUpgradeRoofMaterial(null, "assessor")).toBe(true);
  });
});
