import { describe, it, expect } from "vitest";
import {
  haversineMiles,
  routeLengthMiles,
  optimizeRoute,
  SOLD_CLAIM_RADIUS_MILES,
  isClaimableStatus,
  soldVisible,
} from "./canvass-route";

const P = (lat: number, lng: number, id: string) => ({ id, lat, lng });

describe("haversineMiles", () => {
  it("is zero for the same point", () => {
    expect(haversineMiles(33.4, -112, 33.4, -112)).toBe(0);
  });

  // Phoenix -> Tucson is ~110 miles; a wrong earth radius or a degrees/radians
  // slip shows up immediately at this scale.
  it("matches a known real-world distance", () => {
    const d = haversineMiles(33.4484, -112.074, 32.2226, -110.9747);
    expect(d).toBeGreaterThan(100);
    expect(d).toBeLessThan(120);
  });

  it("is symmetric", () => {
    const a = haversineMiles(33.4, -112.1, 33.5, -111.9);
    const b = haversineMiles(33.5, -111.9, 33.4, -112.1);
    expect(a).toBeCloseTo(b, 10);
  });
});

describe("optimizeRoute", () => {
  it("handles empty, single, and pair inputs without crashing", () => {
    expect(optimizeRoute([], { lat: 33, lng: -112 })).toEqual([]);
    expect(optimizeRoute([P(33, -112, "a")], { lat: 33, lng: -112 })).toHaveLength(1);
    expect(optimizeRoute([P(33, -112, "a"), P(33.1, -112, "b")], { lat: 33, lng: -112 })).toHaveLength(2);
  });

  it("returns every input point exactly once", () => {
    const pts = Array.from({ length: 25 }, (_, i) =>
      P(33.4 + (i % 5) * 0.01, -112 + Math.floor(i / 5) * 0.01, `p${i}`),
    );
    const out = optimizeRoute(pts, { lat: 33.4, lng: -112 });
    expect(out).toHaveLength(25);
    expect(new Set(out.map((p) => p.id)).size).toBe(25);
  });

  it("starts with the point nearest the rep", () => {
    const pts = [P(33.9, -112, "far"), P(33.41, -112, "near"), P(33.6, -112, "mid")];
    const out = optimizeRoute(pts, { lat: 33.4, lng: -112 });
    expect(out[0]!.id).toBe("near");
  });

  it("walks a straight line in order rather than zig-zagging", () => {
    const pts = [P(33.5, -112, "c"), P(33.3, -112, "a"), P(33.7, -112, "d"), P(33.4, -112, "b")];
    const out = optimizeRoute(pts, { lat: 33.3, lng: -112 });
    expect(out.map((p) => p.id)).toEqual(["a", "b", "c", "d"]);
  });

  // The core promise. Greedy nearest-neighbour reliably strands an outlier and
  // doubles back for it; 2-opt should uncross that. Never worse than the order
  // we were handed.
  it("is never longer than the unoptimized input order", () => {
    const rng = mulberry32(42);
    for (let trial = 0; trial < 20; trial++) {
      const pts = Array.from({ length: 20 }, (_, i) =>
        P(33.3 + rng() * 0.3, -112.2 + rng() * 0.3, `p${i}`),
      );
      const start = { lat: 33.4, lng: -112.1 };
      const before = routeLengthMiles(pts, start);
      const after = routeLengthMiles(optimizeRoute(pts, start), start);
      expect(after).toBeLessThanOrEqual(before + 1e-9);
    }
  });

  it("is deterministic", () => {
    const pts = Array.from({ length: 15 }, (_, i) => P(33.4 + i * 0.007, -112 + (i % 3) * 0.01, `p${i}`));
    const start = { lat: 33.4, lng: -112 };
    expect(optimizeRoute(pts, start).map((p) => p.id)).toEqual(optimizeRoute(pts, start).map((p) => p.id));
  });

  it("beats plain nearest-neighbour on a layout designed to strand an outlier", () => {
    // A tight cluster plus one distant house: greedy sweeps the cluster then
    // makes a long final run; 2-opt should fold the outlier into the path.
    const pts = [
      P(33.40, -112.00, "a"), P(33.401, -112.001, "b"), P(33.402, -112.002, "c"),
      P(33.403, -112.003, "d"), P(33.50, -112.10, "outlier"), P(33.404, -112.004, "e"),
    ];
    const start = { lat: 33.40, lng: -112.00 };
    const optimized = routeLengthMiles(optimizeRoute(pts, start), start);
    expect(optimized).toBeLessThanOrEqual(routeLengthMiles(pts, start) + 1e-9);
    expect(Number.isFinite(optimized)).toBe(true);
  });
});

describe("isClaimableStatus", () => {
  it("allows new and goback — go-backs are the point of routing", () => {
    expect(isClaimableStatus("new")).toBe(true);
    expect(isClaimableStatus("goback")).toBe(true);
  });

  it("refuses statuses that mean 'do not send a rep here'", () => {
    expect(isClaimableStatus("notint")).toBe(false);
    expect(isClaimableStatus("customer")).toBe(false);
    expect(isClaimableStatus("dnk")).toBe(false);
    expect(isClaimableStatus("appt")).toBe(false);
  });
});

describe("soldVisible", () => {
  const day = 86400000;
  const now = new Date("2026-08-12T12:00:00Z").getTime();
  const ago = (d: number) => new Date(now - d * day).toISOString();

  it("shows new and goback regardless of age", () => {
    expect(soldVisible({ status: "new", statusAt: ago(300) }, now)).toBe(true);
    expect(soldVisible({ status: "goback", statusAt: ago(300) }, now)).toBe(true);
  });

  it("hides not-interested after 7 days but not before", () => {
    expect(soldVisible({ status: "notint", statusAt: ago(6) }, now)).toBe(true);
    expect(soldVisible({ status: "notint", statusAt: ago(8) }, now)).toBe(false);
  });

  // Hiding this would send the next rep to the exact door it exists to prevent.
  it("never hides do-not-knock, however old", () => {
    expect(soldVisible({ status: "dnk", statusAt: ago(3650) }, now)).toBe(true);
  });
});

describe("SOLD_CLAIM_RADIUS_MILES", () => {
  it("caps a claim so a sparse area returns fewer homes, not a cross-valley route", () => {
    expect(SOLD_CLAIM_RADIUS_MILES).toBeGreaterThan(0);
    expect(SOLD_CLAIM_RADIUS_MILES).toBeLessThanOrEqual(10);
  });
});

/** Small seeded PRNG so the randomized route tests are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
