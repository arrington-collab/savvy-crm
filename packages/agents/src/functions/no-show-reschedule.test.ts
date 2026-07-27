/**
 * no-show-reschedule tests.
 *
 * Full Inngest workflow stepping requires a live server + Postgres (CI-gated).
 * We test the extractable pure/injectable logic here with real assertions:
 *   - buildNoShowSms renders EN/ES with companyName + bookingUrl
 *   - sendNoShowReschedule (the injectable guard+send unit) guards
 *     reason !== "no_show" (nothing happens — sender never called), sends the
 *     localized reschedule SMS via guardedSms WITH quiet-hours enforced for a
 *     consented no_show customer, and is blocked (no send) for an opted-out one
 *   - shouldReenrollAfterNoShow only hands the customer back to cadence on a
 *     confirmed "sent" outcome — never on skip/blocked/deferred
 */
import { it, expect, vi, describe } from "vitest";
import type { SmsSender } from "@savvy/integrations";
import { buildNoShowSms, sendNoShowReschedule, shouldReenrollAfterNoShow } from "./no-show-reschedule";

describe("buildNoShowSms", () => {
  it("renders the EN variant with companyName + bookingUrl", () => {
    const body = buildNoShowSms({ companyName: "Acme Roofing", bookingUrl: "https://x/b/tok", language: "en" });
    expect(body).toContain("Acme Roofing");
    expect(body).toContain("https://x/b/tok");
    expect(body.toLowerCase()).toContain("missed you");
  });

  it("renders the ES variant when language is es", () => {
    const body = buildNoShowSms({ companyName: "Acme Roofing", bookingUrl: "https://x/b/tok", language: "es" });
    expect(body).toContain("Acme Roofing");
    expect(body).toContain("https://x/b/tok");
    expect(body.toLowerCase()).toContain("reprogram");
  });

  it("defaults to EN when language is null/undefined", () => {
    const body = buildNoShowSms({ companyName: "Acme Roofing", bookingUrl: "https://x/b/tok", language: null });
    expect(body.toLowerCase()).toContain("missed you");
  });
});

type SendSmsSpy = ReturnType<typeof vi.fn<SmsSender["sendSms"]>>;

function deps(over: Partial<{ suppressed: boolean; sendSpy: SendSmsSpy }> = {}) {
  const sendSms: SendSmsSpy = over.sendSpy ?? vi.fn(async (_opts) => ({ sid: "SM1" }));
  return {
    isSuppressed: vi.fn(async () => over.suppressed ?? false),
    sms: { sendSms },
    smsFrom: () => "+15550000000",
  };
}

const okConsent = { smsOptOut: false, emailOptOut: false, smsConsentAt: new Date("2026-01-01") };
// Quiet hours 9pm-8am America/Phoenix; noon Phoenix (UTC-7) = 19:00 UTC is outside the window.
const daytimeQuiet = { tz: "America/Phoenix", qh: { startHour: 21, endHour: 8 } };
const middayNow = new Date("2026-01-15T19:00:00Z");

describe("sendNoShowReschedule", () => {
  it("does NOTHING for a non-no_show reason (early return, sender never called)", async () => {
    const spy = vi.fn(async () => ({ sid: "X" }));
    const d = deps({ sendSpy: spy });
    const outcome = await sendNoShowReschedule(d, {
      reason: "done",
      tenantId: "t1",
      customer: { customerId: "c1", phone: "+15551231234", preferredLanguage: "en", ...okConsent },
      companyName: "Acme Roofing",
      bookingUrl: "https://x/b/tok",
      a2pApproved: true,
      quiet: daytimeQuiet,
      now: middayNow,
    });
    expect(outcome).toEqual({ skipped: "not-no-show" });
    expect(spy).not.toHaveBeenCalled();
    expect(shouldReenrollAfterNoShow(outcome)).toBe(false);
  });

  it("also does nothing for rescheduled/canceled/reassigned/weather_rescheduled reasons", async () => {
    for (const reason of ["rescheduled", "canceled", "reassigned", "weather_rescheduled"]) {
      const spy = vi.fn(async () => ({ sid: "X" }));
      const d = deps({ sendSpy: spy });
      const outcome = await sendNoShowReschedule(d, {
        reason,
        tenantId: "t1",
        customer: { customerId: "c1", phone: "+15551231234", preferredLanguage: "en", ...okConsent },
        companyName: "Acme Roofing",
        bookingUrl: "https://x/b/tok",
        a2pApproved: true,
        quiet: daytimeQuiet,
        now: middayNow,
      });
      expect(outcome).toEqual({ skipped: "not-no-show" });
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("sends the localized reschedule SMS via guardedSms for a consented no_show customer", async () => {
    const spy: SendSmsSpy = vi.fn(async (_opts) => ({ sid: "SM1" }));
    const d = deps({ sendSpy: spy });
    const outcome = await sendNoShowReschedule(d, {
      reason: "no_show",
      tenantId: "t1",
      customer: { customerId: "c1", phone: "+15551231234", preferredLanguage: "es", ...okConsent },
      companyName: "Acme Roofing",
      bookingUrl: "https://x/b/tok",
      a2pApproved: true,
      quiet: daytimeQuiet,
      now: middayNow,
    });
    expect("result" in outcome && outcome.result).toEqual({ status: "sent", sid: "SM1" });
    expect(spy).toHaveBeenCalledOnce();
    const call = spy.mock.calls[0]![0];
    expect(call.body).toContain("Acme Roofing");
    expect(call.body).toContain("https://x/b/tok");
    expect(shouldReenrollAfterNoShow(outcome)).toBe(true);
  });

  it("does NOT call the sender when suppressed (blocked) and does not re-enroll", async () => {
    const spy = vi.fn(async () => ({ sid: "X" }));
    const d = deps({ suppressed: true, sendSpy: spy });
    const outcome = await sendNoShowReschedule(d, {
      reason: "no_show",
      tenantId: "t1",
      customer: { customerId: "c1", phone: "+15551231234", preferredLanguage: "en", ...okConsent },
      companyName: "Acme Roofing",
      bookingUrl: "https://x/b/tok",
      a2pApproved: true,
      quiet: daytimeQuiet,
      now: middayNow,
    });
    expect("result" in outcome && outcome.result).toEqual({ status: "blocked", reason: "suppressed" });
    expect(spy).not.toHaveBeenCalled();
    expect(shouldReenrollAfterNoShow(outcome)).toBe(false);
  });

  it("does NOT call the sender when the customer has opted out of SMS and does not re-enroll", async () => {
    const spy = vi.fn(async () => ({ sid: "X" }));
    const d = deps({ sendSpy: spy });
    const outcome = await sendNoShowReschedule(d, {
      reason: "no_show",
      tenantId: "t1",
      customer: { customerId: "c1", phone: "+15551231234", preferredLanguage: "en", smsOptOut: true, emailOptOut: false, smsConsentAt: new Date("2026-01-01") },
      companyName: "Acme Roofing",
      bookingUrl: "https://x/b/tok",
      a2pApproved: true,
      quiet: daytimeQuiet,
      now: middayNow,
    });
    expect("result" in outcome && outcome.result.status).toBe("blocked");
    expect(spy).not.toHaveBeenCalled();
    expect(shouldReenrollAfterNoShow(outcome)).toBe(false);
  });

  it("skips (no send attempted) when the customer has no phone", async () => {
    const spy = vi.fn(async () => ({ sid: "X" }));
    const d = deps({ sendSpy: spy });
    const outcome = await sendNoShowReschedule(d, {
      reason: "no_show",
      tenantId: "t1",
      customer: { customerId: "c1", phone: null, preferredLanguage: "en", ...okConsent },
      companyName: "Acme Roofing",
      bookingUrl: "https://x/b/tok",
      a2pApproved: true,
      quiet: daytimeQuiet,
      now: middayNow,
    });
    expect(outcome).toEqual({ skipped: "no-phone" });
    expect(spy).not.toHaveBeenCalled();
    expect(shouldReenrollAfterNoShow(outcome)).toBe(false);
  });

  it("DOES defer inside quiet hours — unlike C3's immediate missed-call text-back, a no-show reschedule is outreach", async () => {
    const spy = vi.fn(async () => ({ sid: "X" }));
    const d = deps({ sendSpy: spy });
    // 2am Phoenix (UTC-7) = 09:00 UTC, inside the 21-8 quiet window.
    const nightNow = new Date("2026-01-15T09:00:00Z");
    const outcome = await sendNoShowReschedule(d, {
      reason: "no_show",
      tenantId: "t1",
      customer: { customerId: "c1", phone: "+15551231234", preferredLanguage: "en", ...okConsent },
      companyName: "Acme Roofing",
      bookingUrl: "https://x/b/tok",
      a2pApproved: true,
      quiet: daytimeQuiet,
      now: nightNow,
    });
    expect("result" in outcome && outcome.result.status).toBe("deferred");
    expect(spy).not.toHaveBeenCalled();
    expect(shouldReenrollAfterNoShow(outcome)).toBe(false);
  });
});
