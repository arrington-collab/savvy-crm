import { describe, it, expect } from "vitest";
import { generateEstimateLineItems } from "./estimate-engine";
import { measurementAreasSchema } from "./measurement";
import { parseEstimateConfig } from "./estimate-settings";

const cfg = parseEstimateConfig(undefined); // waste 1200 bps, default tiers
const areas = measurementAreasSchema.parse({
  squares: 20, predominantPitch: "8/12", eaveLf: 100, rakeLf: 50, ridgeLf: 30, hipLf: 10, valleyLf: 0,
});
const book = [
  { key: "field-shingles", name: "Field shingles", category: "material" as const, unit: "square" as const, unitPriceCents: 10000, sourceFields: ["squares"], wasteApplies: true, packSize: 1, active: true },
  { key: "starter", name: "Starter", category: "accessory" as const, unit: "lf" as const, unitPriceCents: 200, sourceFields: ["eaveLf"], wasteApplies: false, packSize: 1, active: true },
  { key: "drip-edge", name: "Drip edge", category: "accessory" as const, unit: "lf" as const, unitPriceCents: 150, sourceFields: ["eaveLf", "rakeLf"], wasteApplies: false, packSize: 10, active: true },
  { key: "install", name: "Install labor", category: "labor" as const, unit: "square" as const, unitPriceCents: 8000, sourceFields: ["squares"], wasteApplies: false, packSize: 1, active: true },
  { key: "inactive", name: "Skip me", category: "material" as const, unit: "square" as const, unitPriceCents: 999, sourceFields: ["squares"], wasteApplies: false, packSize: 1, active: false },
];

describe("generateEstimateLineItems", () => {
  const out = generateEstimateLineItems({ areas, priceBook: book, defaultWastePct: cfg.defaultWastePct, pitchTiers: cfg.steepPitchTiers });
  const byKey = Object.fromEntries(out.lineItems.map((l) => [l.key, l]));

  it("waste applies ONLY to field shingles", () => {
    expect(byKey["field-shingles"]!.quantity).toBeCloseTo(22.4); // 20 * 1.12
    expect(byKey["starter"]!.quantity).toBe(100);                // no waste
  });
  it("drip edge rounds up to packSize (10ft sticks)", () => {
    expect(byKey["drip-edge"]!.quantity).toBe(150); // 100+50=150 already multiple of 10
  });
  it("pitch surcharge applies ONLY to labor (8/12 -> +20%)", () => {
    // install base = 20 * 8000 = 160000; +20% = 192000
    expect(byKey["install"]!.amountCents).toBe(192000);
    expect(byKey["install"]!.pitchSurchargePct).toBe(2000);
    expect(byKey["field-shingles"]!.pitchSurchargePct).toBeUndefined();
  });
  it("skips inactive items and reports the applied waste + tier", () => {
    expect(byKey["inactive"]).toBeUndefined();
    expect(out.wastePctUsed).toBe(1200);
    expect(out.pitchTierApplied).toBe("7-9");
  });
});
