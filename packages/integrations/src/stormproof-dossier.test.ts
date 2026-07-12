import { describe, expect, it } from "vitest";
import { shapeDossierProperty, shapeDossierStorm, DOSSIER_STORM_MONTHS } from "@savvy/core";
import { makeFakeStormProof, parseVerifiedTracks, pointInRing, slimHailTracks } from "./stormproof";

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

describe("slimHailTracks (map overlay payload)", () => {
  it("keeps only hail tracks with rings, trimmed to draw fields", async () => {
    const sp = makeFakeStormProof();
    const tracks = await sp.lookupStormTracks({ lat: 33.42, lng: -111.88 });
    const wind = { rings: [[[1, 1], [2, 2], [3, 3]]], eventType: "wind" as const, size: null, windMph: 70, date: "2026-01-01" };
    const ringless = { eventType: "hail" as const, size: 2, windMph: null, date: "2026-01-02" };
    const slim = slimHailTracks([...tracks, wind, ringless]);
    expect(slim).toHaveLength(1);
    expect(slim[0]).toEqual({ rings: tracks[0]!.rings, size: 1.5, date: "2026-05-01" });
    expect(sp.calls.map((c) => c.op)).toEqual(["lookupStormTracks"]);
  });
});
