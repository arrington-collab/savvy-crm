import { describe, it, expect } from "vitest";
import { parseSpeedToLeadConfig, parseLeadCadenceConfig, shouldSendChannel } from "./lead-followup";

describe("parseSpeedToLeadConfig", () => {
  it("defaults to 3 and 10 minutes", () => {
    expect(parseSpeedToLeadConfig({})).toEqual({ firstTouchSlaMin: 3, escalateMin: 10 });
  });
  it("accepts overrides", () => {
    expect(parseSpeedToLeadConfig({ firstTouchSlaMin: 5 }).firstTouchSlaMin).toBe(5);
  });
});

describe("parseLeadCadenceConfig", () => {
  it("defaults to Day 0×2,1,3,5,7,14 and 21–08 quiet hours", () => {
    const c = parseLeadCadenceConfig({});
    expect(c.steps.map((s) => s.dayOffset)).toEqual([0, 0, 1, 3, 5, 7, 14]);
    expect(c.quietHours).toEqual({ startHour: 21, endHour: 8 });
  });
  it("falls back to the default cadence when given an empty steps array", () => {
    expect(parseLeadCadenceConfig({ steps: [] }).steps.map((s) => s.dayOffset)).toEqual([0, 0, 1, 3, 5, 7, 14]);
  });
  it("rejects an out-of-range quiet hour", () => {
    expect(() => parseLeadCadenceConfig({ quietHours: { startHour: 24, endHour: 8 } })).toThrow();
  });
});

describe("parseSpeedToLeadConfig escalateMin", () => {
  it("defaults escalateMin to 10", () => {
    expect(parseSpeedToLeadConfig({}).escalateMin).toBe(10);
  });
});

describe("shouldSendChannel", () => {
  const base = { smsOptOut: false, emailOptOut: false, smsConsentAt: new Date() };
  it("sends SMS only with consent and no opt-out", () => {
    expect(shouldSendChannel("sms", base)).toBe(true);
    expect(shouldSendChannel("sms", { ...base, smsOptOut: true })).toBe(false);
    expect(shouldSendChannel("sms", { ...base, smsConsentAt: null })).toBe(false);
  });
  it("sends email unless opted out", () => {
    expect(shouldSendChannel("email", base)).toBe(true);
    expect(shouldSendChannel("email", { ...base, emailOptOut: true })).toBe(false);
  });
});
