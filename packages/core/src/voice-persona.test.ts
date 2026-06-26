import { describe, it, expect } from "vitest";
import { buildAssistantOverrides, type VoiceLeadContext, parseVoiceOutcome, shouldPlaceVoiceCall } from "./voice-persona";

const baseCtx: VoiceLeadContext = {
  tenantName: "Acme Roofing",
  leadName: "Jane Homeowner",
  address: "123 Main St, Phoenix, AZ",
  stormContext: "1.5\" hail on 2026-05-01",
  leadId: "lead-1",
  tenantId: "tenant-1",
  tz: "America/Phoenix",
};

describe("buildAssistantOverrides", () => {
  it("identifies as the tenant's company in the first message and system prompt", () => {
    const o = buildAssistantOverrides(baseCtx);
    expect(o.firstMessage).toContain("Acme Roofing");
    const sys = o.model.messages.find((m) => m.role === "system")!.content;
    expect(sys).toContain("Acme Roofing");
    expect(sys).toContain("Jane Homeowner");
    expect(sys).toContain("123 Main Street, Phoenix, AZ"); // expanded for natural TTS
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

  it("sets a faster voice speed, expands the address for speech, and instructs relative date labels", () => {
    const o = buildAssistantOverrides(baseCtx);
    expect(o.voice.speed).toBeGreaterThan(1);
    const sys = o.model.messages[0]!.content;
    expect(sys).toContain("123 Main Street"); // St -> Street so TTS doesn't spell it out
    expect(sys).toMatch(/today is/i); // current date available to the agent
    expect(sys).toMatch(/label/i); // told to read the spoken label, not a raw timestamp
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

const guardBase = {
  status: "new",
  firstRepContactAt: null as Date | null,
  phone: "+16025551234",
  smsOptOut: false,
  emailOptOut: false,
  smsConsentAt: new Date("2026-06-01T00:00:00Z"),
  // 2026-06-24 19:00 UTC = 12:00 in America/Phoenix (UTC-7) — outside 21–8 quiet hours
  now: new Date("2026-06-24T19:00:00Z"),
  tz: "America/Phoenix",
  quietHours: { startHour: 21, endHour: 8 },
};

describe("shouldPlaceVoiceCall", () => {
  it("allows an open, uncontacted, consented lead during business hours", () => {
    expect(shouldPlaceVoiceCall(guardBase)).toEqual({ ok: true });
  });
  it("skips a closed/terminal lead", () => {
    expect(shouldPlaceVoiceCall({ ...guardBase, status: "lost" })).toEqual({ ok: false, reason: "closed" });
    expect(shouldPlaceVoiceCall({ ...guardBase, status: "won" })).toEqual({ ok: false, reason: "closed" });
  });
  it("skips an already-contacted lead", () => {
    expect(shouldPlaceVoiceCall({ ...guardBase, firstRepContactAt: new Date() })).toEqual({ ok: false, reason: "contacted" });
  });
  it("skips when there is no phone", () => {
    expect(shouldPlaceVoiceCall({ ...guardBase, phone: null })).toEqual({ ok: false, reason: "no-phone" });
  });
  it("skips when consent is missing or opted out", () => {
    expect(shouldPlaceVoiceCall({ ...guardBase, smsConsentAt: null })).toEqual({ ok: false, reason: "no-consent" });
    expect(shouldPlaceVoiceCall({ ...guardBase, smsOptOut: true })).toEqual({ ok: false, reason: "no-consent" });
  });
  it("skips inside quiet hours (2am Phoenix)", () => {
    // 2026-06-24 09:00 UTC = 02:00 America/Phoenix — inside 21–8 quiet window
    const quiet = { ...guardBase, now: new Date("2026-06-24T09:00:00Z") };
    expect(shouldPlaceVoiceCall(quiet)).toEqual({ ok: false, reason: "quiet-hours" });
  });
});
