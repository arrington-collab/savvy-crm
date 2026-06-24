import { describe, it, expect, vi, afterEach } from "vitest";
import { httpStormProof, makeFakeStormProof } from "./stormproof";

afterEach(() => vi.restoreAllMocks());

describe("stormProof.generateCertificate", () => {
  it("POSTs to /api/leads/certify with x-api-key and parses a verified result", async () => {
    process.env.STORMPROOF_API_BASE = "https://sp.test";
    process.env.STORMPROOF_API_KEY = "bss_live_x";
    const payload = { verified: true, certId: "BSS-1", pdfBase64: "AAAA", verifyUrl: "https://stormproofcerts.com/verify/BSS-1?lat=1&lng=2&date=2026-06-08", storm: { date: "2026-06-08", eventType: "hail", size: 2.75, windMph: null }, checkedMonths: 24 };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => payload });
    vi.stubGlobal("fetch", fetchMock);

    const r = await httpStormProof.generateCertificate({ lat: 1, lng: 2, months: 24 });
    expect(r.verified).toBe(true);
    expect(r.certId).toBe("BSS-1");
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/leads/certify");
    expect(opts.headers["x-api-key"]).toBe("bss_live_x");
    expect(JSON.parse(opts.body)).toMatchObject({ lat: 1, lng: 2, months: 24 });
  });

  it("throws on a non-ok response (so the workflow retries)", async () => {
    process.env.STORMPROOF_API_BASE = "https://sp.test";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));
    await expect(httpStormProof.generateCertificate({ lat: 1, lng: 2 })).rejects.toThrow();
  });

  it("fake returns a deterministic verified result", async () => {
    const fake = makeFakeStormProof();
    const r = await fake.generateCertificate({ lat: 1, lng: 2 });
    expect(r.verified).toBe(true);
    expect(r.pdfBase64).toBeTruthy();
    expect(r.checkedMonths).toBe(24);
  });
});

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
