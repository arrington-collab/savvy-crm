import { describe, it, expect } from "vitest";
import { makeDormantSpotterFeed, makeFakeSpotterFeed, type SpotterPin } from "./spotter-feed";

const pin = (o: Partial<SpotterPin> & { externalId: string }): SpotterPin => ({
  lat: 33.45, lng: -112.07, materialTag: "wood_shake", hasDebris: false,
  spotterName: "Dana", taggedAt: new Date("2026-07-10T00:00:00Z"), address: null, ...o,
});

describe("SpotterFeed seam", () => {
  it("dormant feed returns no pins (bloomroofs adapter not wired by default)", async () => {
    const feed = makeDormantSpotterFeed();
    expect(await feed.fetchPins({})).toEqual([]);
  });

  it("fake feed returns the pins it was seeded with", async () => {
    const feed = makeFakeSpotterFeed([pin({ externalId: "T1" }), pin({ externalId: "T2" })]);
    const pins = await feed.fetchPins({});
    expect(pins.map((p) => p.externalId)).toEqual(["T1", "T2"]);
  });
});
