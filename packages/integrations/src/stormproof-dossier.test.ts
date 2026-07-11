import { describe, expect, it } from "vitest";
import { shapeDossierProperty, shapeDossierStorm, DOSSIER_STORM_MONTHS } from "@savvy/core";
import { makeFakeStormProof } from "./stormproof";

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
