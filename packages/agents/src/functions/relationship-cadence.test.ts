import { describe, it, expect } from "vitest";
import {
  adminDb, tenant, customer, property, job, communication, relationshipTouch, relationshipEnrollment, eq, and, suppress,
} from "@savvy/db";
import { sweepTenantRelationshipCadence } from "./relationship-cadence.js";

const DAY = 86_400_000;

async function seedCompletedJob(opts: { demo?: boolean; completedDaysAgo?: number } = {}) {
  const [t] = await adminDb.insert(tenant).values({
    name: "CadenceSweep", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`,
    demo: opts.demo ?? false,
    settings: { homeowner: { quietHours: { startHour: 0, endHour: 0 } } } as never,
  }).returning();
  const tenantId = t!.id;
  // Stamp smsConsentAt so guardedSms admits the happy-path send.
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "Wanda Warmly", phone: "+16025550888", smsConsentAt: new Date("2026-01-01") }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "9 Cadence Cv" }).returning();
  const completedAt = new Date(Date.now() - (opts.completedDaysAgo ?? 31) * DAY);
  const [j] = await adminDb.insert(job).values({
    tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "complete", stageEnteredAt: completedAt,
  }).returning();
  return { tenantId, customerId: c!.id, jobId: j!.id };
}

function fakeSmsDeps() {
  const sent: { to: string; body: string }[] = [];
  return {
    sent,
    getTenantSms: (async () => ({
      sender: { sendSms: async (m: { to: string; body: string }) => { sent.push(m); return { providerId: "fake" }; } },
      from: "+15555550000",
    })) as never,
  };
}

describe("sweepTenantRelationshipCadence", () => {
  it("enrolls a completed job and sends the due 30-day check-in exactly once", async () => {
    const { tenantId, customerId, jobId } = await seedCompletedJob({ completedDaysAgo: 31 });
    const deps = fakeSmsDeps();

    const first = await sweepTenantRelationshipCadence(tenantId, deps as never);
    expect(first.enrolled).toBe(1);
    expect(first.sent).toBe(1);
    expect(deps.sent[0]!.to).toBe("+16025550888");
    expect(deps.sent[0]!.body).toContain("Wanda");
    expect(deps.sent[0]!.body.toLowerCase()).toContain("free"); // rubric: gratitude/useful/free
    expect(deps.sent[0]!.body.toLowerCase()).not.toContain("discount");

    // The send rode the calendar: touch stamped sent + a communication row.
    const [touch] = await adminDb.select().from(relationshipTouch)
      .where(eq(relationshipTouch.sourceRef, `${jobId}:checkin_30d`));
    expect(touch!.sentAt).toBeInstanceOf(Date);
    const comms = await adminDb.select().from(communication)
      .where(and(eq(communication.customerId, customerId), eq(communication.channel, "sms")));
    expect(comms).toHaveLength(1);

    const again = await sweepTenantRelationshipCadence(tenantId, deps as never);
    expect(again.sent).toBe(0);
    expect(deps.sent).toHaveLength(1);
  });

  // Compliance follow-up: sweepTenantRelationshipCadence previously called
  // sender.sendSms directly, bypassing the global contact_suppression list.
  // Proves guardedSms is wired: a consented, non-opted-out homeowner who is
  // globally suppressed is NOT texted, but the touch is still marked sent
  // (durable — a suppressed customer must not be retried forever) with a
  // comm row whose body reflects the block, excluded from the sent count.
  it("globally suppressed homeowner: sender NOT called, touch still marked sent, comm body reflects block", async () => {
    const { tenantId, customerId, jobId } = await seedCompletedJob({ completedDaysAgo: 31 });
    await suppress({ tenantId, phoneE164: "+16025550888", channel: "sms", reason: "stop", source: "test" });
    const deps = fakeSmsDeps();

    const first = await sweepTenantRelationshipCadence(tenantId, deps as never);
    expect(first.enrolled).toBe(1);
    expect(first.sent).toBe(0);
    expect(deps.sent).toHaveLength(0);

    // Marked sent so it's never retried, even though the guard blocked it.
    const [touch] = await adminDb.select().from(relationshipTouch)
      .where(eq(relationshipTouch.sourceRef, `${jobId}:checkin_30d`));
    expect(touch!.sentAt).toBeInstanceOf(Date);

    const comms = await adminDb.select().from(communication)
      .where(and(eq(communication.customerId, customerId), eq(communication.channel, "sms")));
    expect(comms).toHaveLength(1);
    expect(comms[0]!.body).toContain("blocked");

    // A later sweep never retries the blocked touch.
    const again = await sweepTenantRelationshipCadence(tenantId, deps as never);
    expect(again.sent).toBe(0);
    expect(deps.sent).toHaveLength(0);
  });

  // A THROWN error (transient DB blip / provider 5xx) must NOT be treated as a
  // blocked verdict: no markTouchSent, no real-body comm row, no false sent
  // count — the touch stays due so the next sweep retries.
  it("guardedSms throw: touch NOT marked sent, no real-body comm row — a later sweep retries", async () => {
    const { tenantId, jobId } = await seedCompletedJob({ completedDaysAgo: 31 });
    const throwingDeps = { getTenantSms: (async () => { throw new Error("provider 5xx"); }) as never };

    const first = await sweepTenantRelationshipCadence(tenantId, throwingDeps);
    expect(first.sent).toBe(0);

    const [touch] = await adminDb.select().from(relationshipTouch)
      .where(eq(relationshipTouch.sourceRef, `${jobId}:checkin_30d`));
    expect(touch!.sentAt).toBeNull();

    const deps = fakeSmsDeps();
    const retry = await sweepTenantRelationshipCadence(tenantId, deps as never);
    expect(retry.sent).toBe(1);
    expect(deps.sent).toHaveLength(1);
    expect(deps.sent[0]!.to).toBe("+16025550888");
  });

  it("demo tenants are hard-muted: no enrollment, no sends", async () => {
    const { tenantId, jobId } = await seedCompletedJob({ demo: true });
    const deps = fakeSmsDeps();

    const r = await sweepTenantRelationshipCadence(tenantId, deps as never);
    expect(r).toMatchObject({ enrolled: 0, sent: 0 });
    expect(deps.sent).toHaveLength(0);
    const enr = await adminDb.select().from(relationshipEnrollment).where(eq(relationshipEnrollment.jobId, jobId));
    expect(enr).toHaveLength(0);
  });

  it("due print-channel touches HOLD as print_pending — texts ship day one, print waits for PostGrid", async () => {
    const { tenantId, customerId } = await seedCompletedJob({ completedDaysAgo: 400 }); // stale: no check-in
    // Force the holiday card due NOW.
    const deps = fakeSmsDeps();
    await sweepTenantRelationshipCadence(tenantId, deps as never); // enrolls + schedules
    await adminDb.update(relationshipTouch)
      .set({ scheduledFor: new Date(Date.now() - DAY) })
      .where(and(eq(relationshipTouch.customerId, customerId), eq(relationshipTouch.program, "holiday_card")));

    const r = await sweepTenantRelationshipCadence(tenantId, deps as never);
    expect(r.held).toBe(1);

    const [card] = await adminDb.select().from(relationshipTouch)
      .where(and(eq(relationshipTouch.customerId, customerId), eq(relationshipTouch.program, "holiday_card")));
    expect(card!.suppressedReason).toBe("print_pending");
    expect(card!.sentAt).toBeNull();
    // Held ≠ mailed: no postcard ever hit the SMS rail either.
    expect(deps.sent.filter((s) => s.body.toLowerCase().includes("holiday"))).toHaveLength(0);
  });
});

describe("move_play sends (slice 3)", () => {
  it("a due play-A touch goes out with the Roof-Record framing and stamps sent", async () => {
    const { tenantId, customerId } = await seedCompletedJob({ completedDaysAgo: 400 });
    const { scheduleRelationshipTouch } = await import("@savvy/db");
    const r = await scheduleRelationshipTouch({
      tenantId, customerId, program: "move_play", channel: "text",
      scheduledFor: new Date(Date.now() - DAY), sourceRef: "move-1:play_a",
    });
    expect("touchId" in r).toBe(true);

    const deps = fakeSmsDeps();
    const res = await sweepTenantRelationshipCadence(tenantId, deps as never);
    expect(res.sent).toBeGreaterThanOrEqual(1);
    const playA = deps.sent.find((s) => s.body.includes("Roof Record"));
    expect(playA).toBeTruthy();
    expect(playA!.body).toContain("Wanda");

    const [touch] = await adminDb.select().from(relationshipTouch)
      .where(and(eq(relationshipTouch.customerId, customerId), eq(relationshipTouch.program, "move_play")));
    expect(touch!.sentAt).toBeInstanceOf(Date);
  });
});
