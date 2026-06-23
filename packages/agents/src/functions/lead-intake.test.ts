import { describe, it, expect, vi } from "vitest";
import { qualifyLead, buildBookingSms, enrichProperty } from "./lead-intake";
import { makeFakeStormProof } from "@savvy/integrations";

describe("lead.intake pure steps", () => {
  it("qualifyLead returns score + reason + model from the gateway", async () => {
    const fakeAi = {
      completeObject: vi.fn().mockResolvedValue({ object: { score: 82, reason: "storm zone, owner" }, model: "gemini-flash" }),
    };
    const res = await qualifyLead({ name: "Jane", address: "123 Main", source: "web" }, fakeAi as never);
    expect(res.score).toBe(82);
    expect(res.reason).toBe("storm zone, owner");
    expect(res.model).toBe("gemini-flash");
    expect(fakeAi.completeObject).toHaveBeenCalledOnce();
  });

  it("buildBookingSms includes the booking link and name", () => {
    const body = buildBookingSms({ name: "Jane", bookingUrl: "https://x/book/123" });
    expect(body).toContain("https://x/book/123");
    expect(body).toMatch(/Jane/);
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
