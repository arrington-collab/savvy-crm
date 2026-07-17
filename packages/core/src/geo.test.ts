import { describe, it, expect } from "vitest";
import { nearestWithin } from "./geo";

describe("nearestWithin", () => {
  const candidates = [
    { id: "a", lat: 33.4500, lng: -112.0700 },
    { id: "b", lat: 33.4600, lng: -112.0700 },
  ];

  it("returns the closest candidate inside the radius", () => {
    const hit = nearestWithin({ lat: 33.45005, lng: -112.07 }, candidates, 30);
    expect(hit?.id).toBe("a");
  });

  it("returns null when nothing is within the radius", () => {
    const hit = nearestWithin({ lat: 34.0, lng: -112.07 }, candidates, 30);
    expect(hit).toBeNull();
  });

  it("skips candidates missing coordinates", () => {
    const hit = nearestWithin({ lat: 33.45, lng: -112.07 }, [{ id: "x", lat: null, lng: null }], 50);
    expect(hit).toBeNull();
  });
});
