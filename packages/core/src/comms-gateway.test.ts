import { it, expect } from "vitest";
import { evaluateGuard } from "./comms-gateway";
import type { QuietHours } from "./quiet-hours";

const consentOk = { smsOptOut: false, emailOptOut: false, smsConsentAt: new Date("2026-01-01") };
// Quiet window is 9pm-8am (wraps midnight); 8am-9pm is the allowed send window.
const qh: QuietHours = { startHour: 21, endHour: 8 };
const base = {
  channel: "sms" as const,
  suppressed: false,
  consent: consentOk,
  a2pApproved: true,
  quiet: null,
  cap: { verdict: "admit" as const },
};

it("allows when everything passes", () => {
  expect(evaluateGuard(base).status).toBe("allow");
});

it("blocks suppressed first, before anything else", () => {
  expect(evaluateGuard({ ...base, suppressed: true, a2pApproved: false })).toEqual({
    status: "blocked",
    reason: "suppressed",
  });
});

it("blocks no_consent when sms has no smsConsentAt", () => {
  expect(evaluateGuard({ ...base, consent: { ...consentOk, smsConsentAt: null } })).toEqual({
    status: "blocked",
    reason: "no_consent",
  });
});

it("fails closed on unapproved A2P (sms)", () => {
  expect(evaluateGuard({ ...base, a2pApproved: false })).toEqual({ status: "blocked", reason: "a2p_unapproved" });
});

it("defers inside quiet hours (before cap)", () => {
  // 6am America/Denver = before 8am window
  const now = new Date("2026-07-01T12:00:00Z"); // 06:00 MDT
  const v = evaluateGuard({ ...base, quiet: { tz: "America/Denver", now, qh } });
  expect(v.status).toBe("deferred");
});

it("blocks cap_exceeded when governor refuses", () => {
  expect(evaluateGuard({ ...base, cap: { verdict: "cap_exceeded" } })).toEqual({
    status: "blocked",
    reason: "cap_exceeded",
  });
});

it("email path ignores A2P + sms consent, honors suppression + email opt-out", () => {
  expect(
    evaluateGuard({ ...base, channel: "email", a2pApproved: false, consent: { ...consentOk, smsConsentAt: null } })
      .status,
  ).toBe("allow");
  expect(evaluateGuard({ ...base, channel: "email", consent: { ...consentOk, emailOptOut: true } })).toEqual({
    status: "blocked",
    reason: "no_consent",
  });
});
