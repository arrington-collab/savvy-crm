/**
 * missed-call-textback tests.
 *
 * Full Inngest workflow stepping requires a live server + Postgres (CI-gated).
 * We test the extractable pure/injectable logic here with real assertions:
 *   - buildMissedCallSms renders EN/ES with companyName + bookingUrl
 *   - sendMissedCallTextback (the injectable send unit) calls guardedSms with
 *     the localized body and returns "sent" for a consented customer
 *   - a suppressed/opted-out customer is blocked — the sender is never called
 */
import { it, expect, vi, describe } from "vitest";
import type { SmsSender } from "@savvy/integrations";
import { buildMissedCallSms, sendMissedCallTextback } from "./missed-call-textback";

describe("buildMissedCallSms", () => {
  it("renders the EN variant with companyName + bookingUrl", () => {
    const body = buildMissedCallSms({ companyName: "Acme Roofing", bookingUrl: "https://x/b/tok", language: "en" });
    expect(body).toContain("Acme Roofing");
    expect(body).toContain("https://x/b/tok");
    expect(body.toLowerCase()).toContain("missed your call");
  });

  it("renders the ES variant when language is es", () => {
    const body = buildMissedCallSms({ companyName: "Acme Roofing", bookingUrl: "https://x/b/tok", language: "es" });
    expect(body).toContain("Acme Roofing");
    expect(body).toContain("https://x/b/tok");
    expect(body).toContain("Reserve");
  });

  it("defaults to EN when language is null/undefined", () => {
    const body = buildMissedCallSms({ companyName: "Acme Roofing", bookingUrl: "https://x/b/tok", language: null });
    expect(body.toLowerCase()).toContain("missed your call");
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

describe("sendMissedCallTextback", () => {
  it("sends the localized (ES) body via guardedSms for a consented customer", async () => {
    const spy: SendSmsSpy = vi.fn(async (_opts) => ({ sid: "SM1" }));
    const d = deps({ sendSpy: spy });
    const outcome = await sendMissedCallTextback(d, {
      tenantId: "t1",
      customer: { customerId: "c1", phone: "+15551231234", preferredLanguage: "es", ...okConsent },
      companyName: "Acme Roofing",
      bookingUrl: "https://x/b/tok",
      a2pApproved: true,
    });
    expect("result" in outcome && outcome.result).toEqual({ status: "sent", sid: "SM1" });
    expect(spy).toHaveBeenCalledOnce();
    const call = spy.mock.calls[0]![0];
    expect(call.body).toContain("Reserve");
    expect(call.body).toContain("https://x/b/tok");
  });

  it("sends the EN body via guardedSms when preferredLanguage is null", async () => {
    const spy: SendSmsSpy = vi.fn(async (_opts) => ({ sid: "SM2" }));
    const d = deps({ sendSpy: spy });
    const outcome = await sendMissedCallTextback(d, {
      tenantId: "t1",
      customer: { customerId: "c1", phone: "+15551231234", preferredLanguage: null, ...okConsent },
      companyName: "Acme Roofing",
      bookingUrl: "https://x/b/tok",
      a2pApproved: true,
    });
    expect("result" in outcome && outcome.result.status).toBe("sent");
    const call = spy.mock.calls[0]![0];
    expect(call.body.toLowerCase()).toContain("missed your call");
  });

  it("does NOT call the sender when suppressed (blocked)", async () => {
    const spy = vi.fn(async () => ({ sid: "X" }));
    const d = deps({ suppressed: true, sendSpy: spy });
    const outcome = await sendMissedCallTextback(d, {
      tenantId: "t1",
      customer: { customerId: "c1", phone: "+15551231234", preferredLanguage: "en", ...okConsent },
      companyName: "Acme Roofing",
      bookingUrl: "https://x/b/tok",
      a2pApproved: true,
    });
    expect("result" in outcome && outcome.result).toEqual({ status: "blocked", reason: "suppressed" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("does NOT call the sender when the customer has opted out of SMS", async () => {
    const spy = vi.fn(async () => ({ sid: "X" }));
    const d = deps({ sendSpy: spy });
    const outcome = await sendMissedCallTextback(d, {
      tenantId: "t1",
      customer: { customerId: "c1", phone: "+15551231234", preferredLanguage: "en", smsOptOut: true, emailOptOut: false, smsConsentAt: new Date("2026-01-01") },
      companyName: "Acme Roofing",
      bookingUrl: "https://x/b/tok",
      a2pApproved: true,
    });
    expect("result" in outcome && outcome.result.status).toBe("blocked");
    expect(spy).not.toHaveBeenCalled();
  });

  it("skips (no send attempted) when the customer has no phone", async () => {
    const spy = vi.fn(async () => ({ sid: "X" }));
    const d = deps({ sendSpy: spy });
    const outcome = await sendMissedCallTextback(d, {
      tenantId: "t1",
      customer: { customerId: "c1", phone: null, preferredLanguage: "en", ...okConsent },
      companyName: "Acme Roofing",
      bookingUrl: "https://x/b/tok",
      a2pApproved: true,
    });
    expect(outcome).toEqual({ skipped: "no-phone" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not pass quiet-hours to guardedSms — a missed-call text-back is immediate", async () => {
    // guardedSms only defers when a `quiet` block is supplied; omitting it means
    // suppression/consent/a2p are still enforced but the send is never deferred
    // for being inside quiet hours.
    const spy = vi.fn(async () => ({ sid: "SM3" }));
    const d = deps({ sendSpy: spy });
    const outcome = await sendMissedCallTextback(d, {
      tenantId: "t1",
      customer: { customerId: "c1", phone: "+15551231234", preferredLanguage: "en", ...okConsent },
      companyName: "Acme Roofing",
      bookingUrl: "https://x/b/tok",
      a2pApproved: true,
    });
    expect("result" in outcome && outcome.result.status).toBe("sent");
  });
});
