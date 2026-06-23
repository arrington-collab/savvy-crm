import { describe, it, expect } from "vitest";
import { hybridScore, buildBookingSms, enrichProperty } from "./lead-intake";
import { buildLeadFeatures } from "@savvy/core";
import { makeFakeStormProof } from "@savvy/integrations";

describe("lead.intake pure steps", () => {
  it("buildBookingSms includes the booking link and name", () => {
    const body = buildBookingSms({ name: "Jane", bookingUrl: "https://x/book/123" });
    expect(body).toContain("https://x/book/123");
    expect(body).toMatch(/Jane/);
  });
});

describe("hybridScore", () => {
  it("stays within ±10 of baseline and returns a reason", async () => {
    const features = buildLeadFeatures({ source: "referral", state: "AZ", phone: "+14805551234",
      roofType: "tile", yearBuilt: 2004, storm: { eventCount: 1, maxHailInches: 1.5, maxWindMph: 0, daysSinceWorst: 5 } });
    const fakeAi = { completeObject: async () => ({ object: { score: 999, reason: "Referral + recent hail" }, model: "fake" }) };
    const r = await hybridScore(features, fakeAi as any);
    expect(r.reason).toContain("hail");
    expect(Math.abs(r.score - r.baseline)).toBeLessThanOrEqual(10);
    expect(r.factors.length).toBeGreaterThan(0);
  });
});

describe("enrichProperty", () => {
  it("fills year built + storm summary when lat/lng present", async () => {
    const sp = makeFakeStormProof();
    const out = await enrichProperty(
      { lat: 33.4, lng: -111.8, address: "1 Main St", yearBuilt: null, roofType: null },
      sp,
    );
    expect(out.yearBuilt).toBe(2004);
    expect(out.storm.maxHailInches).toBe(1.5);
    expect(out.stormEventId).toBe("evt_fake_1");
  });
  it("keeps rep-entered year built (does not overwrite)", async () => {
    const sp = makeFakeStormProof();
    const out = await enrichProperty(
      { lat: 33.4, lng: -111.8, address: "1 Main St", yearBuilt: 1999, roofType: "tile" },
      sp,
    );
    expect(out.yearBuilt).toBe(1999);
    expect(out.roofType).toBe("tile");
  });
  it("skips getProperty when lat/lng are null (only looks up storms)", async () => {
    const sp = makeFakeStormProof();
    const out = await enrichProperty({ lat: null, lng: null, address: "unknown", yearBuilt: null, roofType: null }, sp);
    expect(sp.calls.filter((c) => c.op === "getProperty").length).toBe(0);
    expect(sp.calls.filter((c) => c.op === "lookupStorms").length).toBe(1);
    expect(out.yearBuilt).toBeNull();
  });
});
