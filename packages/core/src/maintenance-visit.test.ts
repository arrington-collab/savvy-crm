import { describe, expect, it } from "vitest";
import { computeRoofConditionScore, orderVisitBatch } from "./maintenance-visit";

describe("computeRoofConditionScore — a label earned from zone grades, never a fake number", () => {
  it("all good zones ⇒ good", () => {
    expect(computeRoofConditionScore([{ grade: "good" }, { grade: "good" }])).toMatchObject({ label: "good" });
  });
  it("any monitor zone ⇒ watch; any action zone ⇒ needs_attention", () => {
    expect(computeRoofConditionScore([{ grade: "good" }, { grade: "monitor" }]).label).toBe("watch");
    expect(computeRoofConditionScore([{ grade: "monitor" }, { grade: "action" }]).label).toBe("needs_attention");
  });
  it("ungraded zones are counted honestly and alone yield no verdict", () => {
    const s = computeRoofConditionScore([{ grade: null }, { grade: null }]);
    expect(s.label).toBe("ungraded");
    expect(s.counts.ungraded).toBe(2);
  });
});

describe("orderVisitBatch — neighbors visit on the same day (#307 route batching)", () => {
  // Two clusters ~100km apart; nearest-neighbor from the west cluster.
  const west = [
    { id: "w1", lat: 33.45, lng: -112.07 },
    { id: "w2", lat: 33.46, lng: -112.08 },
    { id: "w3", lat: 33.44, lng: -112.06 },
  ];
  const east = [
    { id: "e1", lat: 33.42, lng: -111.05 },
    { id: "e2", lat: 33.43, lng: -111.06 },
  ];

  it("chunks a proximity-ordered route into per-day batches", () => {
    const days = orderVisitBatch([west[0]!, east[0]!, west[1]!, east[1]!, west[2]!], 3);
    expect(days).toHaveLength(2);
    // Day one is one cluster, not a zig-zag across town.
    const day1 = days[0]!.map((m) => m.id[0]);
    expect(new Set(day1).size).toBe(1);
  });

  it("members without geocodes still get scheduled — appended, never dropped", () => {
    const days = orderVisitBatch([{ id: "a", lat: 33.4, lng: -112.0 }, { id: "b", lat: null, lng: null }], 5);
    expect(days.flat().map((m) => m.id).sort()).toEqual(["a", "b"]);
  });
});
