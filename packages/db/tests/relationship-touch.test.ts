import { describe, it, expect } from "vitest";
import { adminDb, customer, relationshipTouch, eq, and } from "../src/index.js";
import {
  scheduleRelationshipTouch, markTouchSent, listDueTouches, governorCapViolations,
} from "../src/lifecycle/relationship-touch.js";
import { makeTenant } from "./helpers.js";

async function seedCustomer(opts: { mailOptOut?: boolean } = {}) {
  const { tenantId } = await makeTenant();
  const [c] = await adminDb.insert(customer).values({
    tenantId, name: "Loyal Lucy", phone: "+16025551200", mailOptOut: opts.mailOptOut ?? false,
  }).returning();
  return { tenantId, customerId: c!.id };
}

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000);

describe("scheduleRelationshipTouch — nothing sends outside the calendar", () => {
  it("schedules under the cap; the 6th touch in a rolling year refuses with a LOGGED row", async () => {
    const { tenantId, customerId } = await seedCustomer();
    for (let i = 0; i < 5; i++) {
      const r = await scheduleRelationshipTouch({ tenantId, customerId, program: "roofiversary", channel: "text", scheduledFor: inDays(i + 1) });
      expect("touchId" in r).toBe(true);
    }
    const sixth = await scheduleRelationshipTouch({ tenantId, customerId, program: "maintenance_offer", channel: "text", scheduledFor: inDays(10) });
    expect(sixth).toMatchObject({ scheduled: false, reason: "cap_exceeded" });

    // The refusal itself is a ledger row (relationship.governor evidence).
    const rows = await adminDb.select().from(relationshipTouch)
      .where(and(eq(relationshipTouch.customerId, customerId), eq(relationshipTouch.suppressedReason, "cap_exceeded")));
    expect(rows).toHaveLength(1);
  });

  it("a storm_check at the cap DISPLACES the lowest-priority scheduled touch (logged), never the other way", async () => {
    const { tenantId, customerId } = await seedCustomer();
    for (const program of ["roofiversary", "roofiversary", "credit_checkin", "credit_checkin", "holiday_card"]) {
      await scheduleRelationshipTouch({ tenantId, customerId, program, channel: "text", scheduledFor: inDays(5) });
    }
    const storm = await scheduleRelationshipTouch({ tenantId, customerId, program: "storm_check", channel: "text", scheduledFor: inDays(1) });
    expect("touchId" in storm).toBe(true);

    const displaced = await adminDb.select().from(relationshipTouch)
      .where(and(eq(relationshipTouch.customerId, customerId), eq(relationshipTouch.suppressedReason, "displaced")));
    expect(displaced).toHaveLength(1);
    expect(displaced[0]!.program).toBe("holiday_card");
  });

  it("channel opt-out refuses instantly across programs (logged)", async () => {
    const { tenantId, customerId } = await seedCustomer({ mailOptOut: true });
    const r = await scheduleRelationshipTouch({ tenantId, customerId, program: "holiday_card", channel: "postcard", scheduledFor: inDays(30) });
    expect(r).toMatchObject({ scheduled: false, reason: "opt_out" });
  });

  it("idempotent by (program, sourceRef): a replayed scheduler never doubles a touch", async () => {
    const { tenantId, customerId } = await seedCustomer();
    const a = await scheduleRelationshipTouch({ tenantId, customerId, program: "credit_checkin", channel: "text", scheduledFor: inDays(2), sourceRef: "credit-123:12mo" });
    const b = await scheduleRelationshipTouch({ tenantId, customerId, program: "credit_checkin", channel: "text", scheduledFor: inDays(2), sourceRef: "credit-123:12mo" });
    expect((b as { touchId: string }).touchId).toBe((a as { touchId: string }).touchId);
    expect((b as { existing?: boolean }).existing).toBe(true);
  });
});

describe("the send side — only against a scheduled touch", () => {
  it("listDueTouches returns unsent, unsuppressed, due touches; markTouchSent stamps once", async () => {
    const { tenantId, customerId } = await seedCustomer();
    const r = await scheduleRelationshipTouch({ tenantId, customerId, program: "roofiversary", channel: "text", scheduledFor: new Date(Date.now() - 60_000) });
    const touchId = (r as { touchId: string }).touchId;

    const due = await listDueTouches(tenantId, new Date());
    expect(due.map((d) => d.id)).toContain(touchId);

    await markTouchSent({ tenantId, touchId });
    expect((await listDueTouches(tenantId, new Date())).map((d) => d.id)).not.toContain(touchId);
  });
});

describe("relationship.governor evidence", () => {
  it("flags any customer whose SENT touches exceed the cap in a rolling year", async () => {
    const { tenantId, customerId } = await seedCustomer();
    // Simulate a legacy path that wrote sends directly (the rogue-send fixture).
    for (let i = 0; i < 6; i++) {
      await adminDb.insert(relationshipTouch).values({
        tenantId, customerId, program: "custom", channel: "text",
        scheduledFor: new Date(), sentAt: new Date(),
      });
    }
    const violations = await governorCapViolations(tenantId, 5);
    expect(violations).toEqual([{ customerId, sentInWindow: 6 }]);
  });
});
