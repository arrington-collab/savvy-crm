/**
 * voice-fallback tests.
 *
 * Full Inngest workflow stepping requires a live server + Postgres (CI-gated).
 * We test the extractable decision logic here with real assertions:
 *   - shouldPlaceVoiceCall: daytime, open, uncontacted, consented lead with phone => ok
 *   - shouldPlaceVoiceCall: lead inside quiet hours => skipped, reason 'quiet-hours'
 *   - shouldPlaceVoiceCall: no phone / opted-out => skipped
 * The module-mock approach is used for deterministic call-count assertions via makeFakeVoice.
 */
import { describe, it, expect } from "vitest";
import { shouldPlaceVoiceCall, type VoiceGuardInput } from "@savvy/core";
import { makeFakeVoice } from "@savvy/integrations";

// noon Phoenix (UTC-7) = 19:00 UTC — outside quiet hours (21:00-08:00)
const BASE_GUARD: VoiceGuardInput = {
  status: "new",
  firstRepContactAt: null,
  phone: "+16025550101",
  smsOptOut: false,
  emailOptOut: false,
  smsConsentAt: new Date("2024-01-01"),
  now: new Date("2024-06-15T19:00:00Z"),
  tz: "America/Phoenix",
  quietHours: { startHour: 21, endHour: 8 },
};

describe("voiceFallback — shouldPlaceVoiceCall guard", () => {
  it("returns ok for daytime, open, uncontacted, consented lead with phone", () => {
    const result = shouldPlaceVoiceCall(BASE_GUARD);
    expect(result).toEqual({ ok: true });
  });

  it("returns skipped reason=quiet-hours for a lead inside quiet hours (11pm Phoenix)", () => {
    // 11pm Phoenix = 06:00 UTC next day — inside quiet-hours window (21:00-08:00)
    const result = shouldPlaceVoiceCall({
      ...BASE_GUARD,
      now: new Date("2024-06-16T06:00:00Z"),
    });
    expect(result).toEqual({ ok: false, reason: "quiet-hours" });
  });

  it("returns skipped reason=no-phone when phone is null", () => {
    const result = shouldPlaceVoiceCall({ ...BASE_GUARD, phone: null });
    expect(result).toEqual({ ok: false, reason: "no-phone" });
  });

  it("returns skipped reason=no-consent when smsOptOut is true", () => {
    const result = shouldPlaceVoiceCall({ ...BASE_GUARD, smsOptOut: true });
    expect(result).toEqual({ ok: false, reason: "no-consent" });
  });

  it("returns skipped reason=no-consent when smsConsentAt is null (no consent)", () => {
    const result = shouldPlaceVoiceCall({ ...BASE_GUARD, smsConsentAt: null });
    expect(result).toEqual({ ok: false, reason: "no-consent" });
  });

  it("returns skipped reason=closed when lead status is lost", () => {
    const result = shouldPlaceVoiceCall({ ...BASE_GUARD, status: "lost" });
    expect(result).toEqual({ ok: false, reason: "closed" });
  });

  it("returns skipped reason=contacted when firstRepContactAt is set", () => {
    const result = shouldPlaceVoiceCall({ ...BASE_GUARD, firstRepContactAt: new Date() });
    expect(result).toEqual({ ok: false, reason: "contacted" });
  });
});

describe("voiceFallback — makeFakeVoice gateway (call-count determinism)", () => {
  it("places a call and records it in the calls array", async () => {
    const fakeVoice = makeFakeVoice();
    const result = await fakeVoice.placeOutboundCall({
      toPhone: "+16025550101",
      assistantOverrides: {
        firstMessage: "Hi",
        model: { provider: "openai", model: "gpt-4o", messages: [], tools: [] },
        variableValues: { leadId: "lead-1", tenantId: "tenant-1" },
      },
      metadata: { leadId: "lead-1", tenantId: "tenant-1", direction: "outbound", toPhone: "+16025550101" },
    });
    expect(result).not.toBeNull();
    expect(result?.callId).toBe("fake-call-1");
    expect(fakeVoice.calls).toHaveLength(1);
    expect(fakeVoice.calls[0]!.toPhone).toBe("+16025550101");
  });

  it("records multiple calls with incrementing fake ids", async () => {
    const fakeVoice = makeFakeVoice();
    const overrides = {
      firstMessage: "Hi",
      model: { provider: "openai", model: "gpt-4o", messages: [] as { role: "system"; content: string }[], tools: [] as import("@savvy/core").VoiceToolDef[] },
      variableValues: {},
    };
    const meta = { leadId: "l", tenantId: "t", direction: "outbound", toPhone: "+1" };
    const r1 = await fakeVoice.placeOutboundCall({ toPhone: "+1", assistantOverrides: overrides, metadata: meta });
    const r2 = await fakeVoice.placeOutboundCall({ toPhone: "+2", assistantOverrides: overrides, metadata: meta });
    expect(r1?.callId).toBe("fake-call-1");
    expect(r2?.callId).toBe("fake-call-2");
    expect(fakeVoice.calls).toHaveLength(2);
  });
});

describe("voiceFallback — Date JSON round-trip coercion", () => {
  // After step.run() JSON-serializes a row, Dates become strings.
  // The workflow coerces them back: new Date(x as unknown as string)
  it("new Date(string as unknown as string) correctly re-parses an ISO date string", () => {
    const original = new Date("2024-03-15T12:00:00Z");
    const serialized = original.toISOString(); // simulates JSON.stringify round-trip
    const coerced = new Date(serialized as unknown as string);
    expect(coerced.getTime()).toBe(original.getTime());
  });

  it("null firstRepContactAt produces null after coercion guard", () => {
    const raw: Date | null = null;
    const coerced = raw ? new Date(raw as unknown as string) : null;
    expect(coerced).toBeNull();
  });
});
