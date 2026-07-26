import { it, expect, vi } from "vitest";
import type { QuietHours } from "@savvy/core";
import { guardedSms } from "./comms-gateway";

const okConsent = { smsOptOut: false, emailOptOut: false, smsConsentAt: new Date("2026-01-01") };

function deps(over: Partial<{ suppressed: boolean; sendSpy: ReturnType<typeof vi.fn> }> = {}) {
  const sendSms = over.sendSpy ?? vi.fn(async () => ({ sid: "SM1" }));
  return {
    isSuppressed: vi.fn(async () => over.suppressed ?? false),
    sms: { sendSms },
    smsFrom: () => "+15550000000",
  };
}

const args = {
  tenantId: "t1",
  channel: "sms" as const,
  to: "+15551231234",
  body: "hi",
  consent: okConsent,
  a2pApproved: true,
};

it("sends when allowed and returns the sid", async () => {
  const d = deps();
  const r = await guardedSms(d, args);
  expect(r).toEqual({ status: "sent", sid: "SM1" });
  expect(d.sms.sendSms).toHaveBeenCalledOnce();
});

it("does NOT call the sender when suppressed", async () => {
  const spy = vi.fn(async () => ({ sid: "X" }));
  const r = await guardedSms(deps({ suppressed: true, sendSpy: spy }), args);
  expect(r).toEqual({ status: "blocked", reason: "suppressed" });
  expect(spy).not.toHaveBeenCalled();
});

it("fails closed (no send) when a2p not approved", async () => {
  const spy = vi.fn(async () => ({ sid: "X" }));
  const r = await guardedSms(deps({ sendSpy: spy }), { ...args, a2pApproved: false });
  expect(r).toEqual({ status: "blocked", reason: "a2p_unapproved" });
  expect(spy).not.toHaveBeenCalled();
});

it("defers (no send) inside quiet hours", async () => {
  const spy = vi.fn(async () => ({ sid: "X" }));
  // Mirrors packages/core/src/comms-gateway.test.ts: 21-8 quiet window,
  // 06:00 MDT (America/Denver) is inside it.
  const qh: QuietHours = { startHour: 21, endHour: 8 };
  const now = new Date("2026-07-01T12:00:00Z"); // 06:00 MDT
  const r = await guardedSms(deps({ sendSpy: spy }), {
    ...args,
    quiet: { tz: "America/Denver", qh },
    now,
  });
  expect(r.status).toBe("deferred");
  expect(spy).not.toHaveBeenCalled();
});
