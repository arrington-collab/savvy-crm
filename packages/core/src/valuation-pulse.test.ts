import { describe, expect, it } from "vitest";
import { buildValuationLine, detectValuationCards, type ValuationPulseSnapshot } from "./valuation-pulse";

function snap(over: Partial<ValuationPulseSnapshot> = {}): ValuationPulseSnapshot {
  return {
    periodKey: "2026-06", status: "ok",
    valueLowCents: 190_000_000, valueLikelyCents: 225_000_000, valueHighCents: 260_000_000,
    adjustments: [
      { key: "owner_independence", deltaLow: 0.3, deltaHigh: 0.5, rationale: "runs without the owner" },
      { key: "customer_concentration", deltaLow: -0.4, deltaHigh: -0.2, rationale: "top customer 40%" },
    ],
    inputQuality: { real: 8, estimated: 1, missing: 2, flags: { ttmRevenueCents: "real", arOver60Pct: "real" } },
    ...over,
  };
}

describe("buildValuationLine — the monthly pulse, never needy", () => {
  it("carries range, delta, the biggest mover, and one lever", () => {
    const prior = snap({ periodKey: "2026-03", valueLikelyCents: 211_000_000, adjustments: [snap().adjustments[0]!] });
    const line = buildValuationLine(snap(), prior, [{ key: "customer_concentration", label: "Cut top-customer share below 25%", why: "", impactLowCents: 4_000_000, impactHighCents: 8_000_000, href: "/leads" }]);
    expect(line).toContain("$1.9M – $2.6M");
    expect(line).toContain("+$140K");
    expect(line).toContain("customer concentration"); // biggest ledger change vs prior
    expect(line).toContain("Cut top-customer share");
  });

  it("is silent for insufficient snapshots — the digest never nags about missing data", () => {
    expect(buildValuationLine(snap({ status: "insufficient_data", valueLikelyCents: null, valueLowCents: null, valueHighCents: null }), null, [])).toBeNull();
  });
});

describe("detectValuationCards — exceptions, not chatter; break-glass never", () => {
  it("a penalty disappearing is a lever-completed card with the range delta", () => {
    const prior = snap({ periodKey: "2026-05", valueLikelyCents: 205_000_000 });
    const current = snap({ adjustments: [snap().adjustments[0]!] }); // concentration penalty gone
    const cards = detectValuationCards(current, prior);
    const done = cards.find((c) => c.kind === "valuation_move");
    expect(done).toBeDefined();
    expect(done!.title).toContain("customer concentration");
    expect(done!.detail).toContain("+$200K");
  });

  it("a NEW penalty is a threshold-crossed card", () => {
    const prior = snap({ adjustments: [snap().adjustments[0]!] });
    const cards = detectValuationCards(snap(), prior);
    expect(cards.some((c) => c.kind === "valuation_move" && c.title.includes("customer concentration"))).toBe(true);
  });

  it("an input degrading from real to missing is a card (QBO disconnect pattern)", () => {
    const prior = snap();
    const current = snap({ inputQuality: { real: 7, estimated: 1, missing: 3, flags: { ttmRevenueCents: "real", arOver60Pct: "missing" } } });
    const cards = detectValuationCards(current, prior);
    const degraded = cards.find((c) => c.kind === "valuation_input_degraded");
    expect(degraded).toBeDefined();
    expect(degraded!.detail).toContain("arOver60Pct");
  });

  it("identical snapshots produce zero cards", () => {
    expect(detectValuationCards(snap(), snap())).toEqual([]);
  });
});

import { buildValuationAnswers } from "./sage-answers";

describe("Sage: what's my company worth? — answers cite the ledger, never model memory", () => {
  it("cites the range, the adjustment ledger, and links the room", () => {
    const qs = buildValuationAnswers(snap());
    const worth = qs.find((a) => a.q.toLowerCase().includes("worth"));
    expect(worth).toBeDefined();
    expect(worth!.answer).toContain("$1.9M – $2.6M");
    expect(worth!.answer).toContain("runs without the owner");     // ledger cited
    expect(worth!.answer).toContain("not an appraisal");
    expect(worth!.actions?.some((a) => a.href === "/money/owners-room")).toBe(true);
  });

  it("with insufficient data it says so and names the gaps — no invented number", () => {
    const qs = buildValuationAnswers(snap({
      status: "insufficient_data", valueLowCents: null, valueLikelyCents: null, valueHighCents: null,
      reasons: ["TTM revenue unavailable — job-costing actuals not live"],
    } as never));
    const worth = qs.find((a) => a.q.toLowerCase().includes("worth"));
    expect(worth!.answer).not.toMatch(/\$\d/);
    expect(worth!.answer).toContain("job-costing");
  });
});
