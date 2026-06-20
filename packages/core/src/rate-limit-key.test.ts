import { describe, expect, it } from "vitest";
import { rateLimitKey, RATE_LIMITS, type RateBucket } from "./rate-limit-key.js";

describe("rateLimitKey", () => {
  it("joins bucket and id with a colon", () => {
    expect(rateLimitKey("leads", "acme:1.2.3.4")).toBe("leads:acme:1.2.3.4");
  });

  it("namespaces by bucket so different buckets never collide", () => {
    expect(rateLimitKey("crew-pin", "acme")).toBe("crew-pin:acme");
  });
});

describe("RATE_LIMITS", () => {
  it("defines leads at 10 per 60s", () => {
    expect(RATE_LIMITS.leads).toEqual({ limit: 10, windowSeconds: 60 });
  });

  it("defines crew-pin at 5 per 60s", () => {
    expect(RATE_LIMITS["crew-pin"]).toEqual({ limit: 5, windowSeconds: 60 });
  });

  it("RateBucket union matches the map keys", () => {
    const buckets: RateBucket[] = ["leads", "crew-pin"];
    for (const b of buckets) expect(RATE_LIMITS[b]).toBeDefined();
  });
});
