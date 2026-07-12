import { describe, expect, it } from "vitest";
import { shapeDossierProperty, shapeDossierStorm, DOSSIER_STORM_MONTHS } from "@savvy/core";
import { makeFakeStormProof, parseVerifiedTracks, pointInRing, slimStormSwaths, computeHotCells } from "./stormproof";

// The dossier route feeds real gateway results through the @savvy/core shapers.
// This test wires the fake gateway end-to-end: results in → dossier lines out.
describe("dossier assembly from the StormProof gateway", () => {
  it("assembles the storm + property blocks from live gateway results", async () => {
    const sp = makeFakeStormProof();
    const [storms, prop] = await Promise.all([
      sp.lookupStorms({ lat: 39.7392, lng: -104.9903, months: DOSSIER_STORM_MONTHS }),
      sp.getProperty({ lat: 39.7392, lng: -104.9903 }),
    ]);

    const storm = shapeDossierStorm(storms);
    expect(storm).toMatchObject({ worstDate: "2026-05-01", hailInches: 1.5, windMph: null, eventCount: 1 });
    expect(storm!.daysSince).toBeGreaterThan(0);

    const property = shapeDossierProperty(prop);
    expect(property).toMatchObject({ yearBuilt: 2004, roofType: null, supported: true });
    expect(property!.roofAgeYears).toBe(new Date().getFullYear() - 2004);

    // The dossier path is read-only: certificates are never minted here.
    expect(sp.calls.map((c) => c.op).sort()).toEqual(["getProperty", "lookupStorms"]);
  });

  it("omits both blocks when the gateway has nothing (no coords → null / empty)", async () => {
    const sp = makeFakeStormProof();
    const prop = await sp.getProperty({});
    expect(shapeDossierProperty(prop)).toBeNull();
    expect(shapeDossierStorm(null)).toBeNull();
    expect(shapeDossierProperty({ yearBuilt: 2004, roofAge: 22, roofType: "shake", supported: false })).toBeNull();
  });
});

describe("parseVerifiedTracks (/api/storms/verified tracks → dossier events)", () => {
  // 1km-ish square swath around the door at (33.42, -111.88)
  const ring = [[33.415, -111.885], [33.425, -111.885], [33.425, -111.875], [33.415, -111.875]];
  const hailTrack = { rings: [ring], center: { lat: 33.42, lng: -111.88 }, eventType: "hail" as const, size: 1.75, windMph: null, date: "2026-06-12T00:00:00Z" };

  it("marks a track whose swath covers the point as atPoint", () => {
    const ev = parseVerifiedTracks([hailTrack], 33.42, -111.88);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ eventType: "hail", size: 1.75, atPoint: true });
  });

  it("keeps a near-miss (outside swath, center within 10 mi) as atPoint:false", () => {
    // ~0.1° lat ≈ 7 mi north of the ring
    const ev = parseVerifiedTracks([hailTrack], 33.52, -111.88);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.atPoint).toBe(false);
  });

  it("drops tracks farther than the nearby radius", () => {
    // ~0.5° lat ≈ 35 mi away
    expect(parseVerifiedTracks([hailTrack], 33.92, -111.88)).toHaveLength(0);
  });

  it("feeds the shaper end-to-end: swath hit → Verified line, near-miss → nearby line", () => {
    const summarizeLike = (events: ReturnType<typeof parseVerifiedTracks>) => ({
      events, eventCount: events.length, maxHailInches: 1.75, maxWindMph: 0, daysSinceWorst: null,
    });
    const hit = shapeDossierStorm(summarizeLike(parseVerifiedTracks([hailTrack], 33.42, -111.88)))!;
    expect(hit.atPoint).toBe(true);
    const near = shapeDossierStorm(summarizeLike(parseVerifiedTracks([hailTrack], 33.52, -111.88)))!;
    expect(near.atPoint).toBe(false);
  });
});

describe("pointInRing", () => {
  const square = [[0, 0], [0, 10], [10, 10], [10, 0]];
  it("classifies inside/outside", () => {
    expect(pointInRing(5, 5, square)).toBe(true);
    expect(pointInRing(15, 5, square)).toBe(false);
    expect(pointInRing(-1, -1, square)).toBe(false);
  });
});

describe("slimStormSwaths (overlay windows: hail 24 mo, wind 12 mo & >=58 mph)", () => {
  const NOW = new Date("2026-07-11T00:00:00Z");
  const ring = [[33.41, -111.89], [33.43, -111.89], [33.43, -111.87], [33.41, -111.87]];
  const track = (over: Record<string, unknown>) => ({ rings: [ring], eventType: "hail" as const, size: 1.5, windMph: null, date: "2026-05-01", ...over });

  it("applies the per-peril windows and the wind strength floor", () => {
    const slim = slimStormSwaths([
      track({}),                                                              // hail, recent -> keep
      track({ date: "2024-05-01" }),                                          // hail, 26 mo -> drop
      track({ eventType: "wind", size: null, windMph: 74, date: "2025-09-01" }), // wind, 10 mo, severe -> keep
      track({ eventType: "wind", size: null, windMph: 74, date: "2025-05-01" }), // wind, 14 mo -> drop
      track({ eventType: "wind", size: null, windMph: 45, date: "2026-06-01" }), // wind, weak -> drop
      track({ rings: [] }),                                                   // no geometry -> drop
    ], NOW);
    expect(slim.map((s) => s.kind)).toEqual(["hail", "wind"]);
    expect(slim[1]).toMatchObject({ windMph: 74, date: "2025-09-01" });
  });

  it("quantizes ring vertices to 5 dp", () => {
    const slim = slimStormSwaths([track({ rings: [[[33.4123456, -111.8765432], [33.43, -111.89], [33.41, -111.87]]] })], NOW);
    expect(slim[0]!.rings[0]![0]).toEqual([33.41235, -111.87654]);
  });
});

describe("computeHotCells (2+ wind hits = knock target)", () => {
  const NOW = new Date("2026-07-11T00:00:00Z");
  const box = (d: number) => [[33.42 - d, -111.88 - d], [33.42 + d, -111.88 - d], [33.42 + d, -111.88 + d], [33.42 - d, -111.88 + d]];
  const wind = (date: string) => ({ rings: [box(0.03)], eventType: "wind" as const, size: null, windMph: 65, date });
  const hail = { rings: [box(0.02)], eventType: "hail" as const, size: 1.25, windMph: null, date: "2026-06-01" };

  it("counts distinct overlapping wind events per cell and flags hail overlap", () => {
    const swaths = slimStormSwaths([wind("2026-06-20"), wind("2026-05-15"), hail], NOW);
    const cells = computeHotCells(swaths, { lat: 33.42, lng: -111.88 });
    expect(cells.length).toBeGreaterThan(0);
    expect(cells[0]).toMatchObject({ wind: 2 });
    expect(cells.some((c) => c.hail > 0)).toBe(true);
  });

  it("returns nothing for single-hit areas", () => {
    const swaths = slimStormSwaths([wind("2026-06-20"), hail], NOW);
    expect(computeHotCells(swaths, { lat: 33.42, lng: -111.88 })).toEqual([]);
  });
});
