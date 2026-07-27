/**
 * Day 3 §8 acceptance — pure/injectable checks (no DB).
 *
 * Proves the Day-3 feature set (Slices A + B + C, already merged) satisfies
 * the §8 acceptance checks that can be driven with fakes only: a fake
 * SmsSender + an InMemoryStore, mirroring comms-gateway.test.ts's `deps()`
 * factory. The real-Postgres half of §8 (checks 2, 4, 6, 10-real, 7-breach)
 * lives in packages/db/src/command-center/acceptance-day3.test.ts (Task D2).
 *
 * These are acceptance/characterization tests, not RED-first TDD: every seam
 * already exists and is expected to PASS against current code.
 */
import { describe, it, expect, vi } from "vitest";
import type { SmsSender } from "@savvy/integrations";
import { InMemoryStore } from "@savvy/orchestrator";
import { guardedSms } from "../comms-gateway";
import { sendMissedCallTextback, buildMissedCallSms } from "./missed-call-textback";
import { sendNoShowReschedule, buildNoShowSms } from "./no-show-reschedule";
import { bridgeFirstTouch } from "./lead-intake";
import { resolveSendContext } from "../send-context";
import { leadSpeedToLead } from "./lead-speed-to-lead";

const T = "11111111-1111-1111-1111-111111111111";
const okConsent = { smsOptOut: false, emailOptOut: false, smsConsentAt: new Date("2026-01-01") };

type SendSmsSpy = ReturnType<typeof vi.fn<SmsSender["sendSms"]>>;

/** Mirrors comms-gateway.test.ts's deps() factory: a fake SmsSender + injectable isSuppressed. */
function deps(suppressed = false, sendSpy?: SendSmsSpy) {
  const sendSms: SendSmsSpy = sendSpy ?? vi.fn(async (_opts) => ({ sid: "SM1" }));
  return {
    isSuppressed: vi.fn(async () => suppressed),
    sms: { sendSms },
    smsFrom: () => "+15555550100",
  };
}

describe("Day 3 §8 acceptance — units", () => {
  // CHECK 1 — the guardedSms chokepoint can't be bypassed: a suppressed
  // contact is blocked, and the underlying sender is NEVER invoked, across
  // every send unit that routes through it.
  it("§8.1 suppressed contact ⇒ every send unit returns blocked and never calls the sender", async () => {
    // guardedSms directly.
    const g = deps(true);
    const gResult = await guardedSms(g, {
      tenantId: T, channel: "sms", to: "+15551230000", body: "x", consent: okConsent, a2pApproved: true,
    });
    expect(gResult).toEqual({ status: "blocked", reason: "suppressed" });
    expect(g.sms.sendSms).not.toHaveBeenCalled();

    // sendMissedCallTextback — the injectable text-back send unit.
    const mcDeps = deps(true);
    const mc = await sendMissedCallTextback(mcDeps, {
      tenantId: T,
      customer: { customerId: "c1", phone: "+15551231234", preferredLanguage: "en", ...okConsent },
      companyName: "Acme Roofing",
      bookingUrl: "https://x/b/tok",
      a2pApproved: true,
    });
    expect("result" in mc && mc.result).toEqual({ status: "blocked", reason: "suppressed" });
    expect(mcDeps.sms.sendSms).not.toHaveBeenCalled();

    // sendNoShowReschedule — the injectable no-show reschedule send unit.
    const nsDeps = deps(true);
    const ns = await sendNoShowReschedule(nsDeps, {
      reason: "no_show",
      tenantId: T,
      customer: { customerId: "c1", phone: "+15551231234", preferredLanguage: "en", ...okConsent },
      companyName: "Acme Roofing",
      bookingUrl: "https://x/b/tok",
      a2pApproved: true,
      quiet: { tz: "America/Phoenix", qh: { startHour: 21, endHour: 8 } },
      now: new Date("2026-01-15T19:00:00Z"), // noon Phoenix — outside quiet hours, isolates the suppression path
    });
    expect("result" in ns && ns.result).toEqual({ status: "blocked", reason: "suppressed" });
    expect(nsDeps.sms.sendSms).not.toHaveBeenCalled();

    // sendDripStep (drip.ts:72) is NOT unit-testable here without a live
    // Postgres connection: unlike the three units above, it loads the
    // customer row via `withTenant` (a real `db.transaction`) as its very
    // first statement — before guardedSms/isSuppressed is ever consulted —
    // and also logs the comm + advances dripEnrollment.currentStep via the
    // same tenant-scoped tx. Injecting `isSuppressed:()=>true` alone cannot
    // make this pure: there is no live DB in this file (that's the whole
    // point of the pure/injectable split — see Task D1's brief). This is a
    // real gap between the brief's "all four send paths are injectable"
    // framing and drip.ts's actual implementation, not a test bug.
    //
    // The same guarantee this check wants for sendDripStep — a globally
    // suppressed contact is blocked and the sender is never called — IS
    // already proven end-to-end against a real Postgres connection in
    // packages/agents/src/functions/drip-send.test.ts:186-207 ("does NOT
    // call the sender when the contact is globally suppressed (compliance
    // bypass closed)"), which is the correct home for this assertion.
  });

  // CHECK 3 — a quiet-hours-deferred first touch publishes the fields the
  // Speed-to-lead panel (Command Center Day 2) needs to report it correctly.
  it("§8.3 a deferred first-touch publishes quietHoursDeferred + slaLatencySeconds", async () => {
    const store = new InMemoryStore();
    await bridgeFirstTouch(store, {
      tenantId: T, leadId: "l1", latencySeconds: 3,
      occurredAtLeadCreated: "2026-07-27T10:00:00.000Z",
      result: { status: "deferred", untilIso: "2026-07-27T15:00:00.000Z" },
    });
    const audit = store.audits.find((a) => a.event.idempotencyKey === "lead.first_touch:l1");
    expect(audit).toBeTruthy();
    expect(audit!.event.payload).toMatchObject({ quietHoursDeferred: true, slaLatencySeconds: 3 });
  });

  // CHECK 5 — a consented customer gets the missed-call text-back, and the
  // booking URL is actually in the body handed to the sender (not just
  // asserted against the pure builder in isolation).
  it("§8.5 missed-call text-back sends and the booking URL reaches the sender", async () => {
    const spy: SendSmsSpy = vi.fn(async (_opts) => ({ sid: "SM-mc" }));
    const d = deps(false, spy);
    const outcome = await sendMissedCallTextback(d, {
      tenantId: T,
      customer: { customerId: "c1", phone: "+15551231234", preferredLanguage: "en", ...okConsent },
      companyName: "Acme Roofing",
      bookingUrl: "https://x/b/booking-tok",
      a2pApproved: true,
    });
    expect("result" in outcome && outcome.result).toEqual({ status: "sent", sid: "SM-mc" });
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]![0].body).toContain("https://x/b/booking-tok");
  });

  // CHECK 8 — same shape for the no-show reschedule touch.
  it("§8.8 no-show reschedule sends and the booking URL reaches the sender", async () => {
    const spy: SendSmsSpy = vi.fn(async (_opts) => ({ sid: "SM-ns" }));
    const d = deps(false, spy);
    const outcome = await sendNoShowReschedule(d, {
      reason: "no_show",
      tenantId: T,
      customer: { customerId: "c1", phone: "+15551231234", preferredLanguage: "en", ...okConsent },
      companyName: "Acme Roofing",
      bookingUrl: "https://x/b/reschedule-tok",
      a2pApproved: true,
      quiet: { tz: "America/Phoenix", qh: { startHour: 21, endHour: 8 } },
      now: new Date("2026-01-15T19:00:00Z"), // noon Phoenix — outside quiet hours, so it sends immediately
    });
    expect("result" in outcome && outcome.result).toEqual({ status: "sent", sid: "SM-ns" });
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]![0].body).toContain("https://x/b/reschedule-tok");
  });

  // CHECK 9 — bilingual templates render real Spanish bodies (not just "not
  // English"), and resolveSendContext resolves the tenant's branding/tz/quiet
  // hours (locationId is accepted but reserved — see send-context.ts).
  it("§8.9 renders Spanish bodies and resolves tenant send-context", () => {
    const missedCallEs = buildMissedCallSms({ companyName: "Acme", bookingUrl: "https://x/b/u", language: "es" });
    expect(missedCallEs).toContain("Acme");
    expect(missedCallEs).toContain("https://x/b/u");
    expect(missedCallEs).toMatch(/Reserve|Perdón/i);

    const noShowEs = buildNoShowSms({ companyName: "Acme", bookingUrl: "https://x/b/u2", language: "es" });
    expect(noShowEs).toContain("Acme");
    expect(noShowEs).toContain("https://x/b/u2");
    expect(noShowEs.toLowerCase()).toContain("reprogram");

    const ctx = resolveSendContext({ name: "Acme", settings: {} }, null);
    expect(ctx.companyName).toBe("Acme");
    expect(ctx.tz).toBe("America/Phoenix");
    expect(ctx.quietHours).toEqual({ startHour: 21, endHour: 8 });
  });

  // CHECK 10-pure — the idempotency gate: publishing the same leadId's first
  // touch twice records exactly one audit row, not two. The real-Postgres
  // half of this check (one orchestrator_event row) lives in D2.
  it("§8.10 (pure) bridgeFirstTouch called twice for the same leadId does not double-record the audit", async () => {
    const store = new InMemoryStore();
    await bridgeFirstTouch(store, {
      tenantId: T, leadId: "l-idem", latencySeconds: 1,
      occurredAtLeadCreated: "2026-07-27T10:00:00.000Z",
      result: { status: "sent", sid: "SM1" },
    });
    const before = store.audits.length;
    await bridgeFirstTouch(store, {
      tenantId: T, leadId: "l-idem", latencySeconds: 1,
      occurredAtLeadCreated: "2026-07-27T10:00:00.000Z",
      result: { status: "sent", sid: "SM1" },
    });
    expect(store.audits.length).toBe(before);
    expect(store.audits.filter((a) => a.event.idempotencyKey === "lead.first_touch:l-idem")).toHaveLength(1);
  });

  // CHECK 7 (structural) — the breach timer is durable BY CONSTRUCTION:
  // registered with Inngest, cancels on contact/disqualify so a resolved lead
  // never falsely escalates. "Survives a process restart" is an Inngest-
  // runtime durability property (steps checkpoint to Inngest's own storage,
  // replayed by the runtime on worker restart) — it requires a live dev
  // server + an actual process kill/restart + replay to prove, which is
  // fundamentally NOT unit-testable in a Vitest process. This asserts the
  // durable construction only; the breach -> escalation BEHAVIOR (bridgeBreach
  // publishing lead.sla_breach -> speed-to-lead-breach) is covered against a
  // real Postgres exception_queue in the db acceptance file (Task D2, check
  // 7-breach).
  it("§8.7 breach timer is durable-by-construction (cancelOn wired, registered function); true restart is Inngest-runtime only", () => {
    expect(leadSpeedToLead).toBeDefined();
    expect(leadSpeedToLead.id()).toBe("lead-speed-to-lead");
    const opts = leadSpeedToLead.opts as unknown as {
      cancelOn?: { event: string; match?: string }[];
    };
    expect(opts.cancelOn).toEqual([
      { event: "lead/contacted", match: "data.leadId" },
      { event: "lead/disqualified", match: "data.leadId" },
    ]);
  });
});
