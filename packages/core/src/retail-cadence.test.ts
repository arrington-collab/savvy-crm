import { describe, it, expect } from "vitest";
import { parseRetailCadenceConfig, buildRetailTouchBody, DEFAULT_RETAIL_STEPS, stepAbsorbedByRelationship } from "./retail-cadence";

describe("parseRetailCadenceConfig", () => {
  it("defaults to the 7/15/30/60/90 cadence, quiet hours, and non-empty copy", () => {
    const c = parseRetailCadenceConfig(undefined);
    expect(c.enabled).toBe(true);
    expect(c.steps.map((s) => s.dayOffset)).toEqual([7, 15, 30, 60, 90]);
    expect(c.quietHours).toEqual({ startHour: 21, endHour: 8 });
    expect(c.copy.balanceReminder.length).toBeGreaterThan(0);
    expect(c.copy.reviewAsk.length).toBeGreaterThan(0);
    expect(DEFAULT_RETAIL_STEPS.map((s) => s.dayOffset)).toEqual([7, 15, 30, 60, 90]);
  });

  it("accepts overrides and falls back for omitted keys", () => {
    const c = parseRetailCadenceConfig({ enabled: false, steps: [{ dayOffset: 10, channel: "email" }], copy: { reviewAsk: "Rate us!" } });
    expect(c.enabled).toBe(false);
    expect(c.steps).toEqual([{ dayOffset: 10, channel: "email" }]);
    expect(c.copy.reviewAsk).toBe("Rate us!");
    expect(c.copy.balanceReminder.length).toBeGreaterThan(0); // default kept
  });
});

describe("buildRetailTouchBody", () => {
  const copy = { balanceReminder: "A balance remains on your project.", reviewAsk: "Loved your new roof? Leave us a review:" };

  it("includes the balance nudge + pay link AND the review ask when a balance is open", () => {
    const body = buildRetailTouchBody({ balanceCents: 125000, payLink: "https://pay/x", reviewLink: "https://rev/y", copy });
    expect(body).toContain("$1,250.00");
    expect(body).toContain("https://pay/x");
    expect(body).toContain(copy.reviewAsk);
    expect(body).toContain("https://rev/y");
  });

  it("is review/referral only (no balance or pay link) when the balance is settled", () => {
    const body = buildRetailTouchBody({ balanceCents: 0, payLink: "https://pay/x", reviewLink: "https://rev/y", copy });
    expect(body).not.toContain("https://pay/x");
    expect(body).not.toContain("balance");
    expect(body).toContain(copy.reviewAsk);
    expect(body).toContain("https://rev/y");
  });
});

describe("stepAbsorbedByRelationship — Customer for Life absorbs the day-30 touch", () => {
  it("skips the 30-day SMS step when the job is enrolled in the standing cadence", () => {
    expect(stepAbsorbedByRelationship({ dayOffset: 30, channel: "sms" }, true)).toBe(true);
    expect(stepAbsorbedByRelationship({ dayOffset: 30, channel: "sms" }, false)).toBe(false);
    expect(stepAbsorbedByRelationship({ dayOffset: 7, channel: "sms" }, true)).toBe(false);
    expect(stepAbsorbedByRelationship({ dayOffset: 60, channel: "email" }, true)).toBe(false);
  });
});
