import { describe, it, expect } from "vitest";
import { geocode } from "./geocode";

describe("geocode (US Census)", () => {
  it("returns lat/lng from the first address match (x=lng, y=lat)", async () => {
    const fakeFetch = (async (url: string) => {
      expect(url).toContain("onelineaddress");
      expect(url).toContain("benchmark=");
      return new Response(
        JSON.stringify({ result: { addressMatches: [{ coordinates: { x: -111.9, y: 33.4 } }] } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    expect(await geocode("123 Main St, Mesa AZ 85203", fakeFetch)).toEqual({ lat: 33.4, lng: -111.9 });
  });

  it("returns null when there are no matches", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ result: { addressMatches: [] } }), { status: 200 })) as unknown as typeof fetch;
    expect(await geocode("nowhere at all", fakeFetch)).toBeNull();
  });

  it("returns null on a non-200 (fail-soft)", async () => {
    const fakeFetch = (async () => new Response("err", { status: 500 })) as unknown as typeof fetch;
    expect(await geocode("x", fakeFetch)).toBeNull();
  });

  it("returns null when fetch throws (fail-soft)", async () => {
    const fakeFetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await geocode("x", fakeFetch)).toBeNull();
  });

  it("url-encodes the address", async () => {
    let seen = "";
    const fakeFetch = (async (url: string) => {
      seen = url;
      return new Response(JSON.stringify({ result: { addressMatches: [] } }), { status: 200 });
    }) as unknown as typeof fetch;
    await geocode("123 Main St, Mesa AZ", fakeFetch);
    expect(seen).toContain("123%20Main%20St");
  });
});
