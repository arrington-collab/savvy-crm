/**
 * voice-fallback tests.
 *
 * Full Inngest workflow stepping requires a live server + Postgres (CI-gated).
 * We test the workflow's OWN novel inline logic here:
 *   - formatVoiceStormContext: storm-context string builder (hail/wind combos)
 *   - voiceRunOutcome: place-call result → run-status mapping
 * One smoke test verifies shouldPlaceVoiceCall is wired correctly (the happy path).
 */
import { describe, it, expect } from "vitest";
import { shouldPlaceVoiceCall, type VoiceGuardInput } from "@savvy/core";
import { formatVoiceStormContext, voiceRunOutcome } from "./voice-fallback";

// ---------------------------------------------------------------------------
// formatVoiceStormContext
// ---------------------------------------------------------------------------

describe("formatVoiceStormContext — storm-context string builder", () => {
  it("returns hail-only string when only maxHailInches is present", () => {
    expect(formatVoiceStormContext({ storm: { maxHailInches: 1.5 } })).toBe('1.5" hail');
  });

  it("returns wind-only string when only maxWindMph is present", () => {
    expect(formatVoiceStormContext({ storm: { maxWindMph: 65 } })).toBe("65 mph wind");
  });

  it("joins hail and wind with ', ' when both are present", () => {
    expect(formatVoiceStormContext({ storm: { maxHailInches: 2, maxWindMph: 70 } })).toBe('2" hail, 70 mph wind');
  });

  it("returns null when storm object has neither hail nor wind", () => {
    expect(formatVoiceStormContext({ storm: {} })).toBeNull();
  });

  it("returns null when scoreFeatures has no storm key", () => {
    expect(formatVoiceStormContext({ other: "data" })).toBeNull();
  });

  it("returns null for null scoreFeatures", () => {
    expect(formatVoiceStormContext(null)).toBeNull();
  });

  it("returns null for garbage / non-object scoreFeatures", () => {
    expect(formatVoiceStormContext("bad-input")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// voiceRunOutcome
// ---------------------------------------------------------------------------

describe("voiceRunOutcome — place-call run-status mapping", () => {
  it("returns ok + null error when a callId is present", () => {
    expect(voiceRunOutcome({ callId: "vapi-abc-123" })).toEqual({ status: "ok", error: null });
  });

  it("returns skipped + no-vapi-key error when result is null (no key configured)", () => {
    expect(voiceRunOutcome(null)).toEqual({ status: "skipped", error: "no-vapi-key" });
  });
});

// ---------------------------------------------------------------------------
// Smoke test: shouldPlaceVoiceCall happy path (guard is wired; deep coverage in Task 3)
// ---------------------------------------------------------------------------

const BASE_GUARD: VoiceGuardInput = {
  status: "new",
  firstRepContactAt: null,
  phone: "+16025550101",
  smsOptOut: false,
  emailOptOut: false,
  smsConsentAt: new Date("2024-01-01"),
  now: new Date("2024-06-15T19:00:00Z"), // noon Phoenix (UTC-7) — outside quiet hours
  tz: "America/Phoenix",
  quietHours: { startHour: 21, endHour: 8 },
};

describe("voiceFallback — guard smoke test", () => {
  it("shouldPlaceVoiceCall returns ok for daytime, open, consented lead with phone", () => {
    expect(shouldPlaceVoiceCall(BASE_GUARD)).toEqual({ ok: true });
  });
});
