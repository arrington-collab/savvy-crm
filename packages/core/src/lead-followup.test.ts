import { describe, it, expect } from "vitest";
import { parseSpeedToLeadConfig, parseLeadCadenceConfig, shouldSendChannel, buildRepAlertSms } from "./lead-followup";

describe("parseSpeedToLeadConfig", () => {
  it("defaults to 1-minute first touch and 10-minute escalate", () => {
    expect(parseSpeedToLeadConfig({})).toEqual({ firstTouchSlaMin: 1, escalateMin: 10 });
  });
  it("accepts overrides", () => {
    expect(parseSpeedToLeadConfig({ firstTouchSlaMin: 5 }).firstTouchSlaMin).toBe(5);
  });
});

describe("parseLeadCadenceConfig", () => {
  it("defaults to Day 0(+4h),1,3,5,7,14 and 21–08 quiet hours (ack owns t=0)", () => {
    const c = parseLeadCadenceConfig({});
    expect(c.steps.map((s) => s.dayOffset)).toEqual([0, 1, 3, 5, 7, 14]);
    expect(c.steps[0]).toEqual({ dayOffset: 0, hourOffset: 4, channel: "email" }); // no duplicate t=0 SMS
    expect(c.quietHours).toEqual({ startHour: 21, endHour: 8 });
  });
  it("falls back to the default cadence when given an empty steps array", () => {
    expect(parseLeadCadenceConfig({ steps: [] }).steps.map((s) => s.dayOffset)).toEqual([0, 1, 3, 5, 7, 14]);
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

describe("buildRepAlertSms", () => {
  it("uses first name, city, and a tel: tap-to-call link", () => {
    const body = buildRepAlertSms({ name: "Dale Homeowner", city: "Mesa", leadPhone: "+16025550142" });
    expect(body).toContain("Dale");
    expect(body).not.toContain("Homeowner");
    expect(body).toContain("Mesa");
    expect(body).toContain("tel:+16025550142");
    expect(body).toMatch(/speed to lead/i);
  });
  it("omits the city clause when city is null", () => {
    const body = buildRepAlertSms({ name: "Dale", city: null, leadPhone: "+16025550142" });
    expect(body).not.toContain(" in ");
    expect(body).toContain("tel:+16025550142");
  });
});

describe("parseSpeedToLeadConfig first-touch default", () => {
  it("defaults the first-touch SLA to 1 minute", () => {
    expect(parseSpeedToLeadConfig(undefined).firstTouchSlaMin).toBe(1);
  });
});
