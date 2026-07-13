import { describe, it, expect } from "vitest";
import { expandTierEstimates, type TierProductInput, type TierEngineItem } from "./tier-pricing";
import type { MeasurementAreas } from "./measurement";

const AREAS: MeasurementAreas = {
  squares: 30,
  predominantPitch: "4/12",
  ridgeLf: 40,
  hipLf: 0,
  valleyLf: 20,
  eaveLf: 100,
  rakeLf: 60,
  stepFlashingLf: 0,
  penetrationCount: 4,
  facetCount: 4,
};

// Flat pitch tier: no waste bump, no labor surcharge — keeps math easy to assert.
const PITCH_TIERS = [{ minRise: 0, maxRise: null, wasteBumpPct: 0, laborSurchargePct: 0 }];

const item = (over: Partial<TierEngineItem> & { key: string }): TierEngineItem => ({
  name: over.key,
  category: "material",
  unit: "square",
  unitPriceCents: 1000,
  sourceFields: ["squares"],
  wasteApplies: false,
  packSize: 1,
  active: true,
  ...over,
});

const tier = (over: Partial<TierProductInput> & { tier: TierProductInput["tier"] }): TierProductInput => ({
  productName: `${over.tier} shingle`,
  manufacturer: "IKO",
  unitPriceCents: 20000,
  unitCostCents: 12000,
  warrantyText: "warranty",
  recommended: false,
  ...over,
});

const BASE = {
  areas: AREAS,
  defaultWastePct: 1000, // 10% in bps
  pitchTiers: PITCH_TIERS,
  shingleItemKey: "field-shingles",
  defaultMarginFloorBps: 2000, // 20%
};

describe("expandTierEstimates", () => {
  it("produces three tiers, each replacing the base shingle line with the tier product", () => {
    const out = expandTierEstimates({
      ...BASE,
      priceBook: [
        item({ key: "field-shingles", wasteApplies: true, unitPriceCents: 12000, unitCostCents: 7800 }),
        item({ key: "drip-edge", unit: "lf", sourceFields: ["eaveLf", "rakeLf"], unitPriceCents: 200, unitCostCents: 100 }),
      ],
      tierProducts: [
        tier({ tier: "good", productName: "IKO Cambridge", unitPriceCents: 15000 }),
        tier({ tier: "better", productName: "IKO Dynasty", unitPriceCents: 20000, recommended: true }),
        tier({ tier: "best", productName: "TAMKO Titan XT", manufacturer: "TAMKO", unitPriceCents: 26000 }),
      ],
    });

    expect(out.tiers.map((t) => t.tier)).toEqual(["good", "better", "best"]);
    for (const t of out.tiers) {
      const keys = t.lineItems.map((l) => l.key);
      expect(keys).not.toContain("field-shingles");
      expect(keys).toContain("tier-shingles");
      expect(keys).toContain("drip-edge");
    }
    const better = out.tiers.find((t) => t.tier === "better")!;
    expect(better.recommended).toBe(true);
    expect(better.productName).toBe("IKO Dynasty");
    // 30 squares +10% waste = 33 @ $200/sq = $6,600 for the shingle line
    const shingle = better.lineItems.find((l) => l.key === "tier-shingles")!;
    expect(shingle.quantity).toBeCloseTo(33, 5);
    expect(shingle.amountCents).toBe(33 * 20000);
  });

  it("orders tier subtotals by product price (good < better < best)", () => {
    const out = expandTierEstimates({
      ...BASE,
      priceBook: [item({ key: "field-shingles", wasteApplies: true, unitCostCents: 7800 })],
      tierProducts: [
        tier({ tier: "good", unitPriceCents: 15000 }),
        tier({ tier: "better", unitPriceCents: 20000 }),
        tier({ tier: "best", unitPriceCents: 26000 }),
      ],
    });
    const [g, b, be] = out.tiers.map((t) => t.subtotalCents!) as [number, number, number];
    expect(g).toBeLessThan(b);
    expect(b).toBeLessThan(be);
  });

  it("flags a margin-floor violation instead of silently under-flooring", () => {
    const out = expandTierEstimates({
      ...BASE,
      priceBook: [
        item({ key: "field-shingles", wasteApplies: true, unitCostCents: 7800 }),
        // priced at cost: 0% margin, floor is 20%
        item({ key: "drip-edge", unit: "lf", sourceFields: ["eaveLf"], unitPriceCents: 100, unitCostCents: 100 }),
      ],
      tierProducts: [tier({ tier: "good" }), tier({ tier: "better" }), tier({ tier: "best" })],
    });
    const good = out.tiers[0]!;
    const v = good.marginFloorViolations.find((x) => x.key === "drip-edge");
    expect(v).toBeDefined();
    expect(v!.marginBps).toBe(0);
    expect(v!.floorBps).toBe(2000);
    // violation does NOT remove the line or block totals — it surfaces
    expect(good.lineItems.some((l) => l.key === "drip-edge")).toBe(true);
    expect(good.subtotalCents).not.toBeNull();
  });

  it("respects a per-item margin floor override", () => {
    const out = expandTierEstimates({
      ...BASE,
      priceBook: [
        item({ key: "field-shingles", wasteApplies: true, unitCostCents: 7800 }),
        // 10% margin; default floor 20% would flag it, but the item override is 5%
        item({ key: "underlayment", unitPriceCents: 1000, unitCostCents: 900, marginFloorBps: 500 }),
      ],
      tierProducts: [tier({ tier: "good" }), tier({ tier: "better" }), tier({ tier: "best" })],
    });
    expect(out.tiers[0]!.marginFloorViolations.map((v) => v.key)).not.toContain("underlayment");
  });

  it("reports needsCosts (never invents) when a tier product has no price, and skips its total", () => {
    const out = expandTierEstimates({
      ...BASE,
      priceBook: [item({ key: "field-shingles", wasteApplies: true, unitCostCents: 7800 })],
      tierProducts: [
        tier({ tier: "good", unitPriceCents: null }),
        tier({ tier: "better" }),
        tier({ tier: "best", unitCostCents: null }),
      ],
    });
    const good = out.tiers.find((t) => t.tier === "good")!;
    expect(good.subtotalCents).toBeNull();
    expect(good.needsCosts).toContain("good:price");

    // missing COST doesn't block pricing, but is reported and never counted as a margin violation
    const best = out.tiers.find((t) => t.tier === "best")!;
    expect(best.subtotalCents).not.toBeNull();
    expect(best.needsCosts).toContain("best:cost");
    expect(best.marginFloorViolations.map((v) => v.key)).not.toContain("tier-shingles");
  });

  it("computes disposal quantity as squares × tear-off layers", () => {
    const out = expandTierEstimates({
      ...BASE,
      priceBook: [
        item({ key: "field-shingles", wasteApplies: true, unitCostCents: 7800 }),
        item({ key: "disposal", category: "labor", qtyFormula: "disposal", sourceFields: [], unitPriceCents: 3000, unitCostCents: 2000 }),
      ],
      tierProducts: [tier({ tier: "good" }), tier({ tier: "better" }), tier({ tier: "best" })],
      formulaInputs: { layers: 2 },
    });
    const disposal = out.tiers[0]!.lineItems.find((l) => l.key === "disposal")!;
    expect(disposal.quantity).toBe(60); // 30 squares × 2 layers
  });

  it("computes ice & water as eave LF × courses + valley LF", () => {
    const out = expandTierEstimates({
      ...BASE,
      priceBook: [
        item({ key: "field-shingles", wasteApplies: true, unitCostCents: 7800 }),
        item({ key: "ice-water", unit: "lf", qtyFormula: "ice_water", sourceFields: [], unitPriceCents: 250, unitCostCents: 150 }),
      ],
      tierProducts: [tier({ tier: "good" }), tier({ tier: "better" }), tier({ tier: "best" })],
      formulaInputs: { iceWaterCourses: 2 },
    });
    const iw = out.tiers[0]!.lineItems.find((l) => l.key === "ice-water")!;
    expect(iw.quantity).toBe(100 * 2 + 20); // eave 100 × 2 courses + valley 20
  });

  it("takes fixed quantities (e.g. ventilation from the NFA calc) via formulaInputs", () => {
    const out = expandTierEstimates({
      ...BASE,
      priceBook: [
        item({ key: "field-shingles", wasteApplies: true, unitCostCents: 7800 }),
        item({ key: "ridge-vent", unit: "lf", qtyFormula: "fixed", sourceFields: [], unitPriceCents: 800, unitCostCents: 450 }),
      ],
      tierProducts: [tier({ tier: "good" }), tier({ tier: "better" }), tier({ tier: "best" })],
      formulaInputs: { fixedQty: { "ridge-vent": 38 } },
    });
    const rv = out.tiers[0]!.lineItems.find((l) => l.key === "ridge-vent")!;
    expect(rv.quantity).toBe(38);
  });
});
