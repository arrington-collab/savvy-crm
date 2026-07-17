import { describe, it, expect } from "vitest";
import {
  makeDormantAssessorFeed,
  makeFakeAssessorFeed,
  mapMaricopaRoofCover,
  normalizeMaricopaParcel,
  makeMaricopaAssessorFeed,
} from "./assessor-feed";

describe("AssessorFeed seam", () => {
  it("dormant feed returns no parcels (no vendor wired by default)", async () => {
    const feed = makeDormantAssessorFeed();
    expect(await feed.fetchParcels({ county: "maricopa" })).toEqual([]);
  });

  it("fake feed returns the parcels it was seeded with", async () => {
    const feed = makeFakeAssessorFeed([
      { parcelId: "P1", address: "1 A St", roofMaterial: "wood_shake", yearBuilt: 1998, subdivision: "Sun Ridge" },
    ]);
    expect(await feed.fetchParcels({ county: "maricopa" })).toHaveLength(1);
  });
});

describe("mapMaricopaRoofCover — county roof-cover field → structured material", () => {
  it("maps the known Maricopa roof covers", () => {
    expect(mapMaricopaRoofCover("Wood Shake")).toBe("wood_shake");
    expect(mapMaricopaRoofCover("Clay Tile")).toBe("clay_tile");
    expect(mapMaricopaRoofCover("Concrete Tile")).toBe("concrete_tile");
    expect(mapMaricopaRoofCover("Comp Shingle")).toBe("asphalt_shingle");
    expect(mapMaricopaRoofCover("Built-Up")).toBe("flat_builtup");
    expect(mapMaricopaRoofCover("Metal")).toBe("metal");
  });

  it("is case/whitespace tolerant and falls back to 'other'", () => {
    expect(mapMaricopaRoofCover("  clay tile ")).toBe("clay_tile");
    expect(mapMaricopaRoofCover("Slate")).toBe("other");
    expect(mapMaricopaRoofCover("")).toBe("other");
    expect(mapMaricopaRoofCover(null)).toBe("other");
  });
});

describe("normalizeMaricopaParcel — raw county row → AssessorParcel", () => {
  it("extracts parcel id, address, material, year, subdivision", () => {
    const parcel = normalizeMaricopaParcel({
      PARCEL: "123-45-678",
      SITUS_ADDRESS: "742 Evergreen Ter",
      ROOF_COVER: "Wood Shake",
      YEAR_BUILT: "1997",
      SUBDIVISION: "Springfield Heights",
    });
    expect(parcel).toEqual({
      parcelId: "123-45-678",
      address: "742 Evergreen Ter",
      roofMaterial: "wood_shake",
      yearBuilt: 1997,
      subdivision: "Springfield Heights",
    });
  });

  it("tolerates missing year/subdivision", () => {
    const parcel = normalizeMaricopaParcel({ PARCEL: "9", SITUS_ADDRESS: "9 St", ROOF_COVER: "Metal" });
    expect(parcel.yearBuilt).toBeNull();
    expect(parcel.subdivision).toBeNull();
    expect(parcel.roofMaterial).toBe("metal");
  });
});

describe("makeMaricopaAssessorFeed — normalizes raw rows from an injected source", () => {
  it("returns normalized parcels", async () => {
    const feed = makeMaricopaAssessorFeed(async () => [
      { PARCEL: "P1", SITUS_ADDRESS: "1 A St", ROOF_COVER: "Clay Tile", YEAR_BUILT: "1990", SUBDIVISION: "Ridge" },
    ]);
    const parcels = await feed.fetchParcels({ county: "maricopa" });
    expect(parcels).toEqual([
      { parcelId: "P1", address: "1 A St", roofMaterial: "clay_tile", yearBuilt: 1990, subdivision: "Ridge" },
    ]);
  });
});
