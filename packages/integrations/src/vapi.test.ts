import { describe, it, expect } from "vitest";
import { makeFakeVoice, makeHttpVapi, verifyVapiCreds } from "./vapi";
import type { AssistantOverrides } from "@savvy/core";

const overrides: AssistantOverrides = {
  firstMessage: "hi",
  model: { provider: "openai", model: "gpt-4o", messages: [{ role: "system", content: "x" }], tools: [] },
  voice: { speed: 1.15 },
  variableValues: { leadId: "lead-1", tenantId: "tenant-1" },
};

describe("makeFakeVoice", () => {
  it("returns a deterministic fake callId and records the call", async () => {
    const fake = makeFakeVoice();
    const res = await fake.placeOutboundCall({ toPhone: "+16025551234", assistantOverrides: overrides, metadata: { leadId: "lead-1" } });
    expect(res).not.toBeNull();
    expect(res!.callId).toMatch(/^fake-/);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ toPhone: "+16025551234", metadata: { leadId: "lead-1" } });
  });
});

describe("vapi factory", () => {
  it("makeHttpVapi places a call using injected creds", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push(url);
      const body = JSON.parse((init?.body as string) ?? "{}");
      expect(body.assistantId).toBe("asst_byo");
      expect(body.phoneNumberId).toBe("pn_byo");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer key_byo");
      return new Response(JSON.stringify({ id: "call_1" }), { status: 200 });
    }) as unknown as typeof fetch;
    const gw = makeHttpVapi({ apiKey: "key_byo", assistantId: "asst_byo", phoneNumberId: "pn_byo" }, fakeFetch);
    const r = await gw.placeOutboundCall({ toPhone: "+1480", assistantOverrides: {} as never, metadata: {} });
    expect(r).toEqual({ callId: "call_1" });
  });

  it("verifyVapiCreds returns true on 200", async () => {
    const fakeFetch = (async (url: string) => { expect(url).toContain("/assistant/asst_1"); return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    expect(await verifyVapiCreds({ apiKey: "k", assistantId: "asst_1" }, fakeFetch)).toBe(true);
  });

  it("verifyVapiCreds returns false on 401", async () => {
    const fakeFetch = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    expect(await verifyVapiCreds({ apiKey: "bad", assistantId: "asst_1" }, fakeFetch)).toBe(false);
  });
});
