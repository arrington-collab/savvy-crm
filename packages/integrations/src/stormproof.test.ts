import { describe, it, expect } from "vitest";
import { makeFakeStormProof } from "./stormproof";

describe("makeFakeStormProof", () => {
  it("returns deterministic year built + a storm event", async () => {
    const sp = makeFakeStormProof();
    const prop = await sp.getProperty({ lat: 33.4, lng: -111.8, address: "1 Main St" });
    expect(prop?.yearBuilt).toBeTypeOf("number");
    const storms = await sp.lookupStorms({ lat: 33.4, lng: -111.8, months: 12 });
    expect(storms.eventCount).toBeGreaterThanOrEqual(0);
    expect(storms).toHaveProperty("maxHailInches");
    expect(sp.calls.length).toBe(2);
  });
  it("getProperty returns null without lat/lng", async () => {
    const sp = makeFakeStormProof();
    expect(await sp.getProperty({ address: "1 Main St" })).toBeNull();
  });
});
