import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { getTenantSms, getTenantVoice, isOutboundThrottled, type TenantSmsDeps, type TenantVoiceDeps } from "./telephony";

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

describe("statusCallback injection", () => {
  const origEnv = process.env.APP_BASE_URL;

  afterEach(() => {
    if (origEnv === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = origEnv;
  });

  it("injects statusCallback = APP_BASE_URL/api/twilio/status when env is set", async () => {
    process.env.APP_BASE_URL = "https://app.example.com";
    const underlying = vi.fn().mockResolvedValue({ sid: "SM123" });
    const d: TenantSmsDeps = {
      resolve: vi.fn().mockResolvedValue({ source: "platform", twilio: { accountSid: "ACenv", authToken: "tok", from: "+19999999999" } }) as unknown as TenantSmsDeps["resolve"],
      platformSms: { sendSms: underlying },
      platformFrom: () => "+15550000000",
    };
    const { sender } = await getTenantSms("t1", d);
    await sender.sendSms({ to: "+12223334444", from: "+15550000000", body: "hello" });
    expect(underlying).toHaveBeenCalledWith(
      expect.objectContaining({ statusCallback: "https://app.example.com/api/twilio/status" }),
    );
  });

  it("caller-supplied statusCallback wins over injected one", async () => {
    process.env.APP_BASE_URL = "https://app.example.com";
    const underlying = vi.fn().mockResolvedValue({ sid: "SM456" });
    const d: TenantSmsDeps = {
      resolve: vi.fn().mockResolvedValue({ source: "platform", twilio: {} }) as unknown as TenantSmsDeps["resolve"],
      platformSms: { sendSms: underlying },
      platformFrom: () => "+15550000000",
    };
    const { sender } = await getTenantSms("t1", d);
    await sender.sendSms({ to: "+12223334444", from: "+15550000000", body: "hello", statusCallback: "https://custom.example.com/cb" });
    expect(underlying).toHaveBeenCalledWith(
      expect.objectContaining({ statusCallback: "https://custom.example.com/cb" }),
    );
  });

  it("does NOT inject statusCallback when APP_BASE_URL is unset", async () => {
    delete process.env.APP_BASE_URL;
    const underlying = vi.fn().mockResolvedValue({ sid: "SM789" });
    const d: TenantSmsDeps = {
      resolve: vi.fn().mockResolvedValue({ source: "platform", twilio: {} }) as unknown as TenantSmsDeps["resolve"],
      platformSms: { sendSms: underlying },
      platformFrom: () => "+15550000000",
    };
    const { sender } = await getTenantSms("t1", d);
    await sender.sendSms({ to: "+12223334444", from: "+15550000000", body: "hello" });
    const call = underlying.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.statusCallback).toBeUndefined();
  });
});

function vdeps(result: unknown): TenantVoiceDeps {
  return {
    resolve: vi.fn().mockResolvedValue(result) as unknown as TenantVoiceDeps["resolve"],
    platformVoice: { placeOutboundCall: vi.fn().mockResolvedValue({ callId: "platform" }) },
  };
}

describe("isOutboundThrottled", () => {
  it("throttles when rate is below floor with enough sample", async () => {
    const query = vi.fn().mockResolvedValue({ delivered: 10, failed: 15, undelivered: 5 });
    expect(await isOutboundThrottled("t1", query)).toBe(true);
  });
  it("does not throttle a healthy rate", async () => {
    const query = vi.fn().mockResolvedValue({ delivered: 95, failed: 3, undelivered: 2 });
    expect(await isOutboundThrottled("t1", query)).toBe(false);
  });
  it("fails soft to false when the query throws", async () => {
    const query = vi.fn().mockRejectedValue(new Error("db down"));
    expect(await isOutboundThrottled("t1", query)).toBe(false);
  });
});

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
