import { describe, expect, it } from "vitest";
import { computeValuationSnapshot, type ValuationInputs } from "./valuation";
import { parseValuationConfig } from "./valuation-config";

const config = parseValuationConfig(undefined);

// A healthy $2M/45%-GM shop with clean books and low owner-dependence.
function inputs(over: Partial<ValuationInputs> = {}): ValuationInputs {
  return {
    ttmMonths: 12,
    ttmRevenueCents: { value: 200_000_000, quality: "real" },
    ttmGrossMarginPct: { value: 45, quality: "real" },
    insuranceMixPct: { value: 50, quality: "real" },
    maintenanceMrrCents: { value: null, quality: "missing" }, // Phase 20 unbuilt
    topCustomerPct: { value: 10, quality: "real" },
    topLeadSourcePct: { value: 30, quality: "real" },
    coveragePct: { value: 85, quality: "real" },
    founderMinutes30d: { value: 150, quality: "real" },
    backlogCents: { value: 30_000_000, quality: "real" },
    arOver60Pct: { value: 5, quality: "real" },
    qboReconciled: false,
    ...over,
  };
}

describe("computeValuationSnapshot — honesty rules are load-bearing", () => {
  it("HONESTY RED PATH: never renders a range from missing critical inputs", () => {
    const snap = computeValuationSnapshot(inputs({ ttmRevenueCents: { value: null, quality: "missing" } }), config);
    expect(snap.status).toBe("insufficient_data");
    expect(snap.reasons?.length).toBeGreaterThan(0);
    expect(snap.valueLowCents).toBeNull();
    expect(snap.valueHighCents).toBeNull();
  });

  it("HONESTY RED PATH: under the minimum TTM history it refuses, naming the gap", () => {
    const snap = computeValuationSnapshot(inputs({ ttmMonths: 3 }), config);
    expect(snap.status).toBe("insufficient_data");
    expect(snap.reasons?.join(" ")).toContain("month");
  });

  it("outputs a RANGE, never a point — low < likely < high", () => {
    const snap = computeValuationSnapshot(inputs(), config);
    expect(snap.status).toBe("ok");
    expect(snap.valueLowCents!).toBeLessThan(snap.valueLikelyCents!);
    expect(snap.valueLikelyCents!).toBeLessThan(snap.valueHighCents!);
  });

  it("every multiple adjustment is NAMED with a rationale and traceable to an input", () => {
    const snap = computeValuationSnapshot(inputs({ topCustomerPct: { value: 40, quality: "real" } }), config);
    const conc = snap.adjustments.find((a) => a.key === "customer_concentration");
    expect(conc).toBeDefined();
    expect(conc!.deltaHigh).toBeLessThan(0);
    expect(conc!.rationale.length).toBeGreaterThan(10);
    // The final multiple equals base + the sum of the ledger — nothing hidden.
    const sumLow = snap.adjustments.reduce((s, a) => s + a.deltaLow, 0);
    const sumHigh = snap.adjustments.reduce((s, a) => s + a.deltaHigh, 0);
    expect(snap.multipleLow).toBeCloseTo(snap.baseMultipleLow + sumLow, 5);
    expect(snap.multipleHigh).toBeCloseTo(snap.baseMultipleHigh + sumHigh, 5);
  });

  it("owner-independence premium: high coverage + low founder-minutes raises the range", () => {
    const independent = computeValuationSnapshot(inputs(), config);
    const dependent = computeValuationSnapshot(
      inputs({ coveragePct: { value: 40, quality: "real" }, founderMinutes30d: { value: 4000, quality: "real" } }),
      config,
    );
    expect(independent.valueLikelyCents!).toBeGreaterThan(dependent.valueLikelyCents!);
    expect(independent.adjustments.some((a) => a.key === "owner_independence")).toBe(true);
  });

  it("storm-dependence: insurance mix above threshold lowers the range", () => {
    const snap = computeValuationSnapshot(inputs({ insuranceMixPct: { value: 90, quality: "real" } }), config);
    expect(snap.adjustments.some((a) => a.key === "insurance_dependence" && a.deltaHigh < 0)).toBe(true);
  });

  it("missing non-critical inputs WIDEN the range and are flagged — never silent precision", () => {
    const full = computeValuationSnapshot(inputs({ arOver60Pct: { value: 5, quality: "real" } }), config);
    const gappy = computeValuationSnapshot(
      inputs({ arOver60Pct: { value: null, quality: "missing" }, topLeadSourcePct: { value: null, quality: "missing" } }),
      config,
    );
    const fullSpread = full.multipleHigh - full.multipleLow;
    const gappySpread = gappy.multipleHigh - gappy.multipleLow;
    expect(gappySpread).toBeGreaterThan(fullSpread);
    expect(gappy.inputQuality.missing).toBeGreaterThan(full.inputQuality.missing);
  });

  it("stamps the methodology version from config on every snapshot", () => {
    const snap = computeValuationSnapshot(inputs(), config);
    expect(snap.methodologyVersion).toBe(config.version);
  });

  it("EBITDA proxy is flagged estimated until QBO is connected", () => {
    const snap = computeValuationSnapshot(inputs({ qboReconciled: false }), config);
    expect(snap.inputQuality.flags.ebitdaProxy).toBe("estimated");
    const clean = computeValuationSnapshot(inputs({ qboReconciled: true }), config);
    expect(clean.adjustments.some((a) => a.key === "clean_books" && a.deltaLow > 0)).toBe(true);
  });

  it("PROPERTY: value scales with revenue; multiples stay inside sane bounds", () => {
    for (const revenue of [60_000_000, 150_000_000, 400_000_000, 900_000_000]) {
      const snap = computeValuationSnapshot(inputs({ ttmRevenueCents: { value: revenue, quality: "real" } }), config);
      expect(snap.status).toBe("ok");
      expect(snap.multipleLow).toBeGreaterThan(0.5);
      expect(snap.multipleHigh).toBeLessThan(6);
      expect(snap.valueHighCents!).toBeGreaterThan(snap.valueLowCents!);
    }
  });
});

describe("parseValuationConfig (Library, owner-editable, cited)", () => {
  it("ships seeded multiple bands with a citations field the owner can edit", () => {
    expect(config.bands.length).toBeGreaterThanOrEqual(2);
    expect(config.citations.length).toBeGreaterThan(10);
    expect(config.version).toBeTruthy();
  });

  it("falls back to defaults on garbage", () => {
    const c = parseValuationConfig({ bands: "nope" });
    expect(c.bands.length).toBe(config.bands.length);
  });
});
