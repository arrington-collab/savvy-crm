import { describe, it, expect, vi } from "vitest";
import { makeRingCentralSms } from "./ringcentral";

function mockFetch(handlers: Array<(url: string, init: RequestInit) => Response | Promise<Response>>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handlers[Math.min(i++, handlers.length - 1)]!(url, init);
  });
  return { fn: fn as unknown as typeof fetch, calls };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const cfg = {
  serverUrl: "https://platform.ringcentral.test",
  clientId: "cid", clientSecret: "csec", jwt: "jwt-token", from: "+15555550000",
};

describe("makeRingCentralSms", () => {
  it("exchanges the JWT for a token, then sends an SMS with the right shape", async () => {
    const { fn, calls } = mockFetch([
      () => json({ access_token: "AT1", expires_in: 3600 }),
      () => json({ id: 42 }),
    ]);
    const sms = makeRingCentralSms({ ...cfg, fetchImpl: fn });
    const res = await sms.sendSms({ to: "+15551234567", from: cfg.from, body: "hi" });
    expect(res).toEqual({ sid: "42" });

    expect(calls[0]!.url).toBe("https://platform.ringcentral.test/restapi/oauth/token");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      "Basic " + Buffer.from("cid:csec").toString("base64"),
    );
    expect(String(calls[0]!.init.body)).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer");
    expect(String(calls[0]!.init.body)).toContain("assertion=jwt-token");

    expect(calls[1]!.url).toBe("https://platform.ringcentral.test/restapi/v1.0/account/~/extension/~/sms");
    expect((calls[1]!.init.headers as Record<string, string>).authorization).toBe("Bearer AT1");
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({
      from: { phoneNumber: "+15555550000" }, to: [{ phoneNumber: "+15551234567" }], text: "hi",
    });
  });

  it("reuses the cached token across sends (only one auth call)", async () => {
    const { fn, calls } = mockFetch([
      () => json({ access_token: "AT1", expires_in: 3600 }),
      () => json({ id: 1 }),
      () => json({ id: 2 }),
    ]);
    const sms = makeRingCentralSms({ ...cfg, fetchImpl: fn });
    await sms.sendSms({ to: "+1", from: cfg.from, body: "a" });
    await sms.sendSms({ to: "+2", from: cfg.from, body: "b" });
    const authCalls = calls.filter((c) => c.url.endsWith("/restapi/oauth/token"));
    expect(authCalls).toHaveLength(1);
  });

  it("throws a descriptive error on a non-2xx send", async () => {
    const { fn } = mockFetch([
      () => json({ access_token: "AT1", expires_in: 3600 }),
      () => json({ message: "bad" }, 400),
    ]);
    const sms = makeRingCentralSms({ ...cfg, fetchImpl: fn });
    await expect(sms.sendSms({ to: "+1", from: cfg.from, body: "x" })).rejects.toThrow(/ringcentral send failed: 400/);
  });
});
