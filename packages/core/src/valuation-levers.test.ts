import { describe, expect, it } from "vitest";
import { computeValuationSnapshot, type ValuationInputs } from "./valuation";
import { parseValuationConfig } from "./valuation-config";
import { buildValueLevers } from "./valuation-levers";

const config = parseValuationConfig(undefined);

function inputs(over: Partial<ValuationInputs> = {}): ValuationInputs {
  return {
    ttmMonths: 12,
    ttmRevenueCents: { value: 200_000_000, quality: "real" },
    ttmGrossMarginPct: { value: 45, quality: "real" },
    insuranceMixPct: { value: 90, quality: "real" },          // penalty active
    maintenanceMrrCents: { value: null, quality: "missing" },  // lever available
    topCustomerPct: { value: 40, quality: "real" },            // penalty active
    topLeadSourcePct: { value: 30, quality: "real" },
    coveragePct: { value: 50, quality: "real" },               // premium NOT earned
    founderMinutes30d: { value: 3000, quality: "real" },
    backlogCents: { value: 0, quality: "real" },
    arOver60Pct: { value: 5, quality: "real" },
    qboReconciled: false,                                       // lever available
    ...over,
  };
}

describe("buildValueLevers — levers derive from the ledger, never generic advice", () => {
  const snap = computeValuationSnapshot(inputs(), config);
  const levers = buildValueLevers(snap, config);

  it("ranks 3-5 concrete moves with dollar impact ranges and machinery links", () => {
    expect(levers.length).toBeGreaterThanOrEqual(3);
    expect(levers.length).toBeLessThanOrEqual(5);
    for (const l of levers) {
      expect(l.impactLowCents).toBeGreaterThan(0);
      expect(l.impactHighCents).toBeGreaterThanOrEqual(l.impactLowCents);
      expect(l.href).toMatch(/^\//);
      expect(l.why.length).toBeGreaterThan(10);
    }
    // Sorted by upside, biggest first.
    const highs = levers.map((l) => l.impactHighCents);
    expect([...highs].sort((a, b) => b - a)).toEqual(highs);
  });

  it("an unearned owner-independence premium becomes a coverage/founder-minutes lever", () => {
    expect(levers.some((l) => l.key === "owner_independence")).toBe(true);
  });

  it("an active concentration penalty becomes a diversification lever worth the penalty removal", () => {
    const lever = levers.find((l) => l.key === "customer_concentration");
    expect(lever).toBeDefined();
    // Removing a [-0.4,-0.2] penalty on this SDE is worth delta × SDE.
    expect(lever!.impactHighCents).toBe(Math.round(snap.sdeCents! * 0.4));
  });

  it("earned premiums do not appear as levers", () => {
    const cleanSnap = computeValuationSnapshot(
      inputs({ coveragePct: { value: 85, quality: "real" }, founderMinutes30d: { value: 100, quality: "real" } }),
      config,
    );
    const cleanLevers = buildValueLevers(cleanSnap, config);
    expect(cleanLevers.some((l) => l.key === "owner_independence")).toBe(false);
  });

  it("insufficient snapshots yield no levers (nothing to lever against)", () => {
    const bad = computeValuationSnapshot(inputs({ ttmMonths: 2 }), config);
    expect(buildValueLevers(bad, config)).toEqual([]);
  });
});
