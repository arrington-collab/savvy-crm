import { describe, expect, it, vi } from "vitest";
import { getTenantSms, getTenantVoice, type TenantSmsDeps, type TenantVoiceDeps } from "./telephony";

function deps(resolveResult: unknown): TenantSmsDeps {
  return {
    resolve: vi.fn().mockResolvedValue(resolveResult) as unknown as TenantSmsDeps["resolve"],
    platformSms: { sendSms: vi.fn().mockResolvedValue({ sid: "platform" }) },
    platformFrom: () => "+15550000000",
  };
}

describe("getTenantSms", () => {
  it("byo + active with full creds → tenant sender + tenant from", async () => {
    const d = deps({ source: "tenant", twilio: { accountSid: "AC1", authToken: "tok", from: "+14801112222" } });
    const r = await getTenantSms("t1", d);
    expect(r.from).toBe("+14801112222");
    // tenant sender is a fresh makeTwilioSms instance, not the platform mock
    expect(r.sender).not.toBe(d.platformSms);
  });

  it("platform mode → platform sender + platform from", async () => {
    const d = deps({ source: "platform", twilio: { accountSid: "ACenv", authToken: "tokenv", from: "+19999999999" } });
    const r = await getTenantSms("t1", d);
    expect(r.sender).toBe(d.platformSms);
    expect(r.from).toBe("+15550000000");
  });

  it("byo inactive → platform fallback", async () => {
    const d = deps({ source: "inactive" });
    const r = await getTenantSms("t1", d);
    expect(r.sender).toBe(d.platformSms);
    expect(r.from).toBe("+15550000000");
  });

  it("tenant source but empty placeholder creds → platform fallback", async () => {
    const d = deps({ source: "tenant", twilio: { accountSid: "", authToken: "", from: "" } });
    const r = await getTenantSms("t1", d);
    expect(r.sender).toBe(d.platformSms);
  });
});

function vdeps(result: unknown): TenantVoiceDeps {
  return {
    resolve: vi.fn().mockResolvedValue(result) as unknown as TenantVoiceDeps["resolve"],
    platformVoice: { placeOutboundCall: vi.fn().mockResolvedValue({ callId: "platform" }) },
  };
}

describe("getTenantVoice", () => {
  it("byo + active full creds → tenant gateway (not platform)", async () => {
    const d = vdeps({ source: "tenant", vapi: { apiKey: "k", assistantId: "a", phoneNumberId: "p" } });
    const gw = await getTenantVoice("t1", d);
    expect(gw).not.toBe(d.platformVoice);
  });
  it("platform → platform gateway", async () => {
    const d = vdeps({ source: "platform", vapi: { apiKey: "k", assistantId: "a", phoneNumberId: "p" } });
    expect(await getTenantVoice("t1", d)).toBe(d.platformVoice);
  });
  it("inactive → platform gateway", async () => {
    const d = vdeps({ source: "inactive" });
    expect(await getTenantVoice("t1", d)).toBe(d.platformVoice);
  });
  it("tenant but empty creds → platform gateway", async () => {
    const d = vdeps({ source: "tenant", vapi: { apiKey: "", assistantId: "", phoneNumberId: "" } });
    expect(await getTenantVoice("t1", d)).toBe(d.platformVoice);
  });
});
