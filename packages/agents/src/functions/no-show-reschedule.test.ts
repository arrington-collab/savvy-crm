/**
 * no-show-reschedule tests.
 *
 * Full Inngest workflow stepping requires a live server + Postgres (CI-gated).
 * We test the extractable pure/injectable logic here with real assertions:
 *   - buildNoShowSms renders EN/ES with companyName + bookingUrl
 *   - quietSleepUntil (the pure "should the handler sleep, and until when"
 *     decision that gates the Inngest handler's `step.sleepUntil` — this is
 *     what fixes the night no-show silently no-op'ing instead of sending later)
 *   - sendNoShowReschedule (the injectable guard+send unit) guards
 *     reason !== "no_show" (nothing happens — sender never called), sends the
 *     localized reschedule SMS via guardedSms WITH quiet-hours enforced for a
 *     consented no_show customer, and is blocked (no send) for an opted-out one
 *   - shouldReenrollAfterNoShow only hands the customer back to cadence on a
 *     confirmed "sent" outcome — never on skip/blocked/deferred
 */
import { it, expect, vi, describe } from "vitest";
import type { SmsSender } from "@savvy/integrations";
import { buildNoShowSms, sendNoShowReschedule, shouldReenrollAfterNoShow, quietSleepUntil } from "./no-show-reschedule";

describe("quietSleepUntil", () => {
  // Quiet hours 9pm-8am America/Phoenix (UTC-7, no DST).
  const qh = { startHour: 21, endHour: 8 };

  it("returns the next-allowed Date to sleep until when now is inside quiet hours (night)", () => {
    // 2am Phoenix (UTC-7) = 09:00 UTC, inside the 21-8 quiet window.
    const nightNow = new Date("2026-01-15T09:00:00Z");
    const until = quietSleepUntil(nightNow, "America/Phoenix", qh);
    expect(until).not.toBeNull();
    expect(until!.getTime()).toBeGreaterThan(nightNow.getTime());
    // Lands at 8am Phoenix = 15:00 UTC, the first hour outside the window.
    expect(until!.toISOString()).toBe("2026-01-15T15:00:00.000Z");
  });

  it("returns null (send now, no sleep) when now is already outside quiet hours (daytime)", () => {
    // Noon Phoenix (UTC-7) = 19:00 UTC, outside the 21-8 window.
    const middayNow = new Date("2026-01-15T19:00:00Z");
    expect(quietSleepUntil(middayNow, "America/Phoenix", qh)).toBeNull();
  });
});

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

  it("guardedSms itself still reports 'deferred' for a night `now` — unlike C3's immediate missed-call text-back, a no-show reschedule is outreach that respects quiet hours at the guard level", async () => {
    // This calls sendNoShowReschedule DIRECTLY with a still-in-quiet-hours
    // `now`, bypassing the Inngest handler's new sleep-then-send gate
    // (quietSleepUntil + step.sleepUntil in no-show-reschedule.ts). In
    // production the handler now sleeps past quiet hours BEFORE ever reaching
    // this function, so guardedSms sees an in-window `now` and sends — this
    // "deferred" result is the raw guard behavior (defense-in-depth), not the
    // real end-to-end outcome for a night no-show anymore. See quietSleepUntil
    // tests above for the sleep-decision that fixes the silent-drop bug.
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
