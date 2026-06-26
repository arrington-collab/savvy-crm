import { describe, it, expect } from "vitest";
import { makeFakeVoice } from "./vapi";
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
