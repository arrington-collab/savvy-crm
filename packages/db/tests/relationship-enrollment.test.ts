import { describe, it, expect } from "vitest";
import { adminDb, customer, job, relationshipTouch, relationshipEnrollment, eq, and } from "../src/index.js";
import {
  enrollCompletedJobs, extendStandingCadence, holdDuePrintTouches,
  dueCadenceTextTouches, enrollmentGaps, cadenceSilenceViolations,
} from "../src/lifecycle/relationship-enrollment.js";
import { scheduleRelationshipTouch } from "../src/lifecycle/relationship-touch.js";
import { makeTenant, makeJobWithCustomer } from "./helpers.js";

const DAY = 86_400_000;

async function completeJob(tenantId: string, opts: { completedAt: Date }) {
  const { jobId, customerId } = await makeJobWithCustomer(tenantId);
  await adminDb.update(job).set({ stage: "complete", stageEnteredAt: opts.completedAt }).where(eq(job.id, jobId));
  return { jobId, customerId };
}

const touchesFor = (customerId: string) =>
  adminDb.select().from(relationshipTouch).where(eq(relationshipTouch.customerId, customerId));

describe("enrollCompletedJobs — every completed job enrolls exactly once", () => {
  it("enrolls a fresh completion with 30-day check-in, year-1 roofiversary, and a held-for-holiday postcard", async () => {
    const { tenantId } = await makeTenant();
    const now = new Date("2026-07-14T18:00:00Z");
    const completedAt = new Date("2026-07-01T18:00:00Z");
    const { jobId, customerId } = await completeJob(tenantId, { completedAt });

    const r = await enrollCompletedJobs(tenantId, now);
    expect(r.enrolled).toBe(1);

    const [enr] = await adminDb.select().from(relationshipEnrollment).where(eq(relationshipEnrollment.jobId, jobId));
    expect(enr).toBeTruthy();
    expect(enr!.customerId).toBe(customerId);
    expect(enr!.suppressedReason).toBeNull();

    const touches = await touchesFor(customerId);
    const byRef = Object.fromEntries(touches.map((t) => [t.sourceRef, t]));
    expect(byRef[`${jobId}:checkin_30d`]).toMatchObject({ program: "checkin_30d", channel: "text" });
    expect(byRef[`${jobId}:checkin_30d`]!.scheduledFor.toISOString().slice(0, 10)).toBe("2026-07-31");
    expect(byRef[`${jobId}:roofiversary:1`]).toMatchObject({ program: "roofiversary", channel: "text" });
    expect(byRef[`${jobId}:roofiversary:1`]!.scheduledFor.toISOString().slice(0, 10)).toBe("2027-07-01");
    // Default holiday = Thanksgiving 2026 (Nov 26), on the print channel.
    expect(byRef[`${jobId}:holiday:2026`]).toMatchObject({ program: "holiday_card", channel: "postcard" });
    expect(byRef[`${jobId}:holiday:2026`]!.scheduledFor.toISOString().slice(0, 10)).toBe("2026-11-26");
  });

  it("is idempotent: a second sweep enrolls nothing and doubles no touches", async () => {
    const { tenantId } = await makeTenant();
    const now = new Date("2026-07-14T18:00:00Z");
    const { customerId } = await completeJob(tenantId, { completedAt: new Date(now.getTime() - 10 * DAY) });

    await enrollCompletedJobs(tenantId, now);
    const again = await enrollCompletedJobs(tenantId, now);
    expect(again.enrolled).toBe(0);
    expect((await touchesFor(customerId)).length).toBe(3);
  });

  it("a stale completion (>45d ago) skips the 30-day check-in but still gets the standing programs", async () => {
    const { tenantId } = await makeTenant();
    const now = new Date("2026-07-14T18:00:00Z");
    const { jobId, customerId } = await completeJob(tenantId, { completedAt: new Date(now.getTime() - 90 * DAY) });

    await enrollCompletedJobs(tenantId, now);
    const refs = (await touchesFor(customerId)).map((t) => t.sourceRef);
    expect(refs).not.toContain(`${jobId}:checkin_30d`);
    expect(refs).toContain(`${jobId}:roofiversary:1`);
  });
});

describe("claim-dispute hold — no touches during an active dispute", () => {
  it("scheduleRelationshipTouch refuses with a claim_dispute ledger row while the flag is set", async () => {
    const { tenantId } = await makeTenant();
    const { customerId } = await makeJobWithCustomer(tenantId);
    await adminDb.update(customer).set({ claimDisputeHold: true }).where(eq(customer.id, customerId));

    const r = await scheduleRelationshipTouch({
      tenantId, customerId, program: "roofiversary", channel: "text", scheduledFor: new Date(),
    });
    expect(r).toMatchObject({ scheduled: false, reason: "claim_dispute" });

    const rows = await adminDb.select().from(relationshipTouch)
      .where(and(eq(relationshipTouch.customerId, customerId), eq(relationshipTouch.suppressedReason, "claim_dispute")));
    expect(rows).toHaveLength(1);
  });
});

describe("extendStandingCadence — the machine remembers postcard #7 in year four", () => {
  it("schedules the NEXT roofiversary and holiday card once the scheduled ones are in the past/sent", async () => {
    const { tenantId } = await makeTenant();
    const now = new Date("2027-08-01T18:00:00Z"); // a year later; year-1 roofiversary sent
    const completedAt = new Date("2026-07-01T18:00:00Z");
    const { jobId, customerId } = await completeJob(tenantId, { completedAt });

    await enrollCompletedJobs(tenantId, new Date("2026-07-14T18:00:00Z"));
    const ext = await extendStandingCadence(tenantId, now);
    expect(ext.scheduled).toBeGreaterThanOrEqual(2); // roofiversary:2 + holiday:2027

    const refs = (await touchesFor(customerId)).map((t) => t.sourceRef);
    expect(refs).toContain(`${jobId}:roofiversary:2`);
    expect(refs).toContain(`${jobId}:holiday:2027`);

    // Re-run: nothing new (idempotent by sourceRef, refusals included).
    const again = await extendStandingCadence(tenantId, now);
    expect(again.scheduled).toBe(0);
  });
});

describe("print pending — the calendar holds postcards until PostGrid lands", () => {
  it("a due print-channel touch is held with suppressed_reason=print_pending, never silently dropped", async () => {
    const { tenantId } = await makeTenant();
    const { customerId } = await makeJobWithCustomer(tenantId);
    const r = await scheduleRelationshipTouch({
      tenantId, customerId, program: "holiday_card", channel: "postcard",
      scheduledFor: new Date(Date.now() - DAY), sourceRef: "x:holiday:2026",
    });
    expect("touchId" in r).toBe(true);

    const held = await holdDuePrintTouches(tenantId, new Date());
    expect(held.held).toBe(1);

    const rows = await adminDb.select().from(relationshipTouch)
      .where(and(eq(relationshipTouch.customerId, customerId), eq(relationshipTouch.suppressedReason, "print_pending")));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sentAt).toBeNull();
  });
});

describe("dueCadenceTextTouches — what the sweep actually sends", () => {
  it("returns due text touches with contact info; skips opted-out and dispute-held customers", async () => {
    const { tenantId } = await makeTenant();
    const a = await makeJobWithCustomer(tenantId);
    const b = await makeJobWithCustomer(tenantId);
    await adminDb.update(customer).set({ phone: "+16025550001" }).where(eq(customer.id, a.customerId));
    await adminDb.update(customer).set({ phone: "+16025550002", claimDisputeHold: true }).where(eq(customer.id, b.customerId));

    const past = new Date(Date.now() - DAY);
    const ra = await scheduleRelationshipTouch({ tenantId, customerId: a.customerId, program: "checkin_30d", channel: "text", scheduledFor: past, sourceRef: "a:checkin_30d" });
    expect("touchId" in ra).toBe(true);
    // b was NOT dispute-held at schedule time; the hold landed after.
    await adminDb.update(customer).set({ claimDisputeHold: false }).where(eq(customer.id, b.customerId));
    await scheduleRelationshipTouch({ tenantId, customerId: b.customerId, program: "roofiversary", channel: "text", scheduledFor: past, sourceRef: "b:roofiversary:1" });
    await adminDb.update(customer).set({ claimDisputeHold: true }).where(eq(customer.id, b.customerId));

    const due = await dueCadenceTextTouches(tenantId, new Date());
    expect(due.map((d) => d.customerId)).toContain(a.customerId);
    expect(due.map((d) => d.customerId)).not.toContain(b.customerId);
    expect(due.find((d) => d.customerId === a.customerId)).toMatchObject({ phone: "+16025550001", program: "checkin_30d" });
  });
});

describe("evidence", () => {
  it("relationship.enrollment: a completed job without an enrollment is a gap; the sweep clears it", async () => {
    const { tenantId } = await makeTenant();
    const now = new Date();
    const { jobId } = await completeJob(tenantId, { completedAt: new Date(now.getTime() - 5 * DAY) });

    const before = await enrollmentGaps(tenantId, now);
    expect(before.map((g) => g.jobId)).toContain(jobId);

    await enrollCompletedJobs(tenantId, now);
    expect((await enrollmentGaps(tenantId, now)).map((g) => g.jobId)).not.toContain(jobId);
  });

  it("relationship.cadence: an enrolled customer silent >18mo is a violation; a sent touch clears it", async () => {
    const { tenantId } = await makeTenant();
    const { jobId, customerId } = await completeJob(tenantId, { completedAt: new Date("2024-01-10T00:00:00Z") });
    await adminDb.insert(relationshipEnrollment).values({
      tenantId, customerId, jobId,
      completedAt: new Date("2024-01-10T00:00:00Z"), enrolledAt: new Date("2024-01-15T00:00:00Z"),
    });

    const now = new Date("2026-07-14T00:00:00Z");
    const silent = await cadenceSilenceViolations(tenantId, now);
    expect(silent.map((v) => v.customerId)).toContain(customerId);

    await adminDb.insert(relationshipTouch).values({
      tenantId, customerId, program: "roofiversary", channel: "text",
      scheduledFor: new Date("2026-01-10T00:00:00Z"), sentAt: new Date("2026-01-10T17:00:00Z"),
    });
    expect((await cadenceSilenceViolations(tenantId, now)).map((v) => v.customerId)).not.toContain(customerId);
  });

  it("relationship.cadence: fully opted-out customers are unreachable by choice, not violations", async () => {
    const { tenantId } = await makeTenant();
    const { jobId, customerId } = await completeJob(tenantId, { completedAt: new Date("2024-01-10T00:00:00Z") });
    await adminDb.update(customer)
      .set({ smsOptOut: true, emailOptOut: true, mailOptOut: true })
      .where(eq(customer.id, customerId));
    await adminDb.insert(relationshipEnrollment).values({
      tenantId, customerId, jobId,
      completedAt: new Date("2024-01-10T00:00:00Z"), enrolledAt: new Date("2024-01-15T00:00:00Z"),
    });

    const silent = await cadenceSilenceViolations(tenantId, new Date("2026-07-14T00:00:00Z"));
    expect(silent.map((v) => v.customerId)).not.toContain(customerId);
  });
});

describe("jobHasActiveEnrollment — the retail drip's absorption check", () => {
  it("true only after enrollment, false for never-enrolled jobs", async () => {
    const { jobHasActiveEnrollment } = await import("../src/lifecycle/relationship-enrollment.js");
    const { tenantId } = await makeTenant();
    const now = new Date();
    const { jobId } = await completeJob(tenantId, { completedAt: new Date(now.getTime() - 5 * DAY) });

    expect(await jobHasActiveEnrollment(tenantId, jobId)).toBe(false);
    await enrollCompletedJobs(tenantId, now);
    expect(await jobHasActiveEnrollment(tenantId, jobId)).toBe(true);
  });
});
