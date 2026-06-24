import { describe, it, expect } from "vitest";
import { staticMapImageUrl, mapsPlaceLinkUrl } from "./maps";

describe("staticMapImageUrl", () => {
  it("uses lat,lng when both are finite", () => {
    const url = staticMapImageUrl({ apiKey: "K", lat: 33.5, lng: -112.06 });
    expect(url).toContain("https://maps.googleapis.com/maps/api/staticmap?");
    expect(url).toContain("center=33.5%2C-112.06");
    expect(url).toContain("markers=color%3Ared%7C33.5%2C-112.06");
    expect(url).toContain("maptype=hybrid");
    expect(url).toContain("zoom=18");
    expect(url).toContain("scale=2");
    expect(url).toContain("size=600x300");
    expect(url).toContain("key=K");
  });

  it("falls back to the address string when coords are missing", () => {
    const url = staticMapImageUrl({ apiKey: "K", lat: null, lng: null, address: "1600 E Camelback Rd, Phoenix" });
    expect(url).toContain("center=1600%20E%20Camelback%20Rd%2C%20Phoenix");
  });

  it("returns null with no apiKey", () => {
    expect(staticMapImageUrl({ apiKey: "", lat: 33.5, lng: -112.06 })).toBeNull();
  });

  it("returns null when there is no usable location", () => {
    expect(staticMapImageUrl({ apiKey: "K", lat: null, lng: null, address: "  " })).toBeNull();
  });

  it("ignores partial coords (lat only) and uses the address", () => {
    const url = staticMapImageUrl({ apiKey: "K", lat: 33.5, lng: null, address: "Phoenix" });
    expect(url).toContain("center=Phoenix");
  });
});

describe("mapsPlaceLinkUrl", () => {
  it("prefers lat,lng", () => {
    expect(mapsPlaceLinkUrl({ lat: 33.5, lng: -112.06 })).toBe(
      "https://www.google.com/maps/search/?api=1&query=33.5%2C-112.06",
    );
  });

  it("falls back to address", () => {
    expect(mapsPlaceLinkUrl({ address: "Phoenix, AZ" })).toBe(
      "https://www.google.com/maps/search/?api=1&query=Phoenix%2C%20AZ",
    );
  });

  it("returns null with no location", () => {
    expect(mapsPlaceLinkUrl({ lat: null, lng: null, address: null })).toBeNull();
  });
});
