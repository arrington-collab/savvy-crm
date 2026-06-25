import { describe, it, expect } from "vitest";
import { buildAssistantOverrides, type VoiceLeadContext, parseVoiceOutcome } from "./voice-persona";

const baseCtx: VoiceLeadContext = {
  tenantName: "Acme Roofing",
  leadName: "Jane Homeowner",
  address: "123 Main St, Phoenix, AZ",
  stormContext: "1.5\" hail on 2026-05-01",
  leadId: "lead-1",
  tenantId: "tenant-1",
};

describe("buildAssistantOverrides", () => {
  it("identifies as the tenant's company in the first message and system prompt", () => {
    const o = buildAssistantOverrides(baseCtx);
    expect(o.firstMessage).toContain("Acme Roofing");
    const sys = o.model.messages.find((m) => m.role === "system")!.content;
    expect(sys).toContain("Acme Roofing");
    expect(sys).toContain("Jane Homeowner");
    expect(sys).toContain("123 Main St, Phoenix, AZ");
  });

  it("embeds every guardrail phrase verbatim", () => {
    const sys = buildAssistantOverrides(baseCtx).model.messages[0]!.content;
    expect(sys).toMatch(/do not (quote|discuss) (pricing|prices)/i);
    expect(sys).toMatch(/deductible/i);
    expect(sys).toMatch(/insurance fraud/i);
    expect(sys).toMatch(/TCPA/);
    expect(sys).toMatch(/quiet hours/i);
    expect(sys).toMatch(/do not call/i); // DNC
    expect(sys).toMatch(/hand (off|you )?.*(human|representative|rep)/i);
  });

  it("includes the storm context when present and omits it when null", () => {
    expect(buildAssistantOverrides(baseCtx).model.messages[0]!.content).toContain("1.5\" hail");
    const noStorm = buildAssistantOverrides({ ...baseCtx, stormContext: null });
    expect(noStorm.model.messages[0]!.content).not.toMatch(/hail|recent storm/i);
  });

  it("defines the getRecommendedSlots and bookSlot tools", () => {
    const tools = buildAssistantOverrides(baseCtx).model.tools;
    const names = tools.map((t) => t.function.name);
    expect(names).toContain("getRecommendedSlots");
    expect(names).toContain("bookSlot");
    const book = tools.find((t) => t.function.name === "bookSlot")!;
    expect(book.function.parameters.required).toEqual(expect.arrayContaining(["startsAt", "endsAt"]));
  });

  it("passes leadId + tenantId through variableValues for the webhook to read", () => {
    const o = buildAssistantOverrides(baseCtx);
    expect(o.variableValues).toMatchObject({ leadId: "lead-1", tenantId: "tenant-1" });
  });
});

describe("parseVoiceOutcome", () => {
  it("maps each known Vapi outcome string to the enum", () => {
    expect(parseVoiceOutcome("booked")).toBe("booked");
    expect(parseVoiceOutcome("no_answer")).toBe("no_answer");
    expect(parseVoiceOutcome("callback")).toBe("callback");
    expect(parseVoiceOutcome("dnc")).toBe("dnc");
    expect(parseVoiceOutcome("needs_human")).toBe("needs_human");
  });
  it("is case/whitespace tolerant", () => {
    expect(parseVoiceOutcome("  Booked ")).toBe("booked");
    expect(parseVoiceOutcome("NO_ANSWER")).toBe("no_answer");
  });
  it("returns null for unknown, empty, null, or undefined", () => {
    expect(parseVoiceOutcome("voicemail")).toBeNull();
    expect(parseVoiceOutcome("")).toBeNull();
    expect(parseVoiceOutcome(null)).toBeNull();
    expect(parseVoiceOutcome(undefined)).toBeNull();
  });
});
