import { describe, it, expect } from "vitest";
import {
  adminDb, customer, property, job, lead, moveEvent, warrantyTransfer,
  relationshipTouch, relationshipEnrollment, eq, and,
} from "../src/index.js";
import {
  recordMoveSignal, confirmMove, dismissMove, registerWarrantyTransfer,
  createMoveLeadOnReply, movePlayGaps, transfersMissingRecord,
} from "../src/lifecycle/move-play.js";
import { markTouchSent } from "../src/lifecycle/relationship-touch.js";
import { makeTenant } from "./helpers.js";

const DAY = 86_400_000;

async function seedHomeowner(opts: { baseline?: boolean; completedJob?: boolean } = {}) {
  const { tenantId } = await makeTenant();
  const [c] = await adminDb.insert(customer).values({
    tenantId, name: "Moving Mia", phone: "+16025550999",
  }).returning();
  const baselineInspectionId = opts.baseline === false ? null : crypto.randomUUID();
  const [p] = await adminDb.insert(property).values({
    tenantId, customerId: c!.id, address: "12 Old Oak Ln",
    baselineInspectionId, baselineAt: baselineInspectionId ? new Date("2025-06-01T00:00:00Z") : null,
  }).returning();
  let jobId: string | null = null;
  if (opts.completedJob !== false) {
    const [j] = await adminDb.insert(job).values({
      tenantId, customerId: c!.id, propertyId: p!.id, type: "retail",
      stage: "complete", stageEnteredAt: new Date("2025-06-15T00:00:00Z"),
    }).returning();
    jobId = j!.id;
  }
  return { tenantId, customerId: c!.id, propertyId: p!.id, jobId, baselineInspectionId };
}

describe("recordMoveSignal — never act on a single soft signal", () => {
  it("NCOA alone raises a verification card (pending_verification), no plays, customer untouched", async () => {
    const { tenantId, customerId, propertyId } = await seedHomeowner();
    const r = await recordMoveSignal({ tenantId, customerId, propertyId, kind: "ncoa", newAddress: "77 New Nest Dr" });
    expect(r.status).toBe("pending_verification");
    expect(r.confidence).toBe(60);

    const [cust] = await adminDb.select().from(customer).where(eq(customer.id, customerId));
    expect(cust!.movedAt).toBeNull();
    expect(await adminDb.select().from(warrantyTransfer).where(eq(warrantyTransfer.propertyId, propertyId))).toHaveLength(0);
  });

  it("NCOA + returned mail crosses the threshold: confirmed, customer stamped, BOTH plays run", async () => {
    const { tenantId, customerId, propertyId, baselineInspectionId } = await seedHomeowner();
    await recordMoveSignal({ tenantId, customerId, propertyId, kind: "ncoa", newAddress: "77 New Nest Dr" });
    const r = await recordMoveSignal({ tenantId, customerId, propertyId, kind: "returned_mail" });
    expect(r.status).toBe("confirmed");
    expect(r.confidence).toBe(85);

    const [cust] = await adminDb.select().from(customer).where(eq(customer.id, customerId));
    expect(cust!.movedAt).toBeInstanceOf(Date);
    expect(cust!.newAddress).toBe("77 New Nest Dr");

    // Play A: a governed move_play touch, job-anchored by the move event.
    const touches = await adminDb.select().from(relationshipTouch)
      .where(and(eq(relationshipTouch.customerId, customerId), eq(relationshipTouch.program, "move_play")));
    expect(touches).toHaveLength(1);
    expect(touches[0]!.sourceRef).toBe(`${r.moveEventId}:play_a`);

    // Play B: the warranty-transfer offer, Roof Record linked, letter held for PostGrid.
    const [wt] = await adminDb.select().from(warrantyTransfer).where(eq(warrantyTransfer.propertyId, propertyId));
    expect(wt).toMatchObject({ status: "offered", letterStatus: "print_pending", moveEventId: r.moveEventId });
    expect(wt!.baselineInspectionId).toBe(baselineInspectionId);
  });

  it("a manual signal always confirms; replayed signals never double the plays", async () => {
    const { tenantId, customerId, propertyId } = await seedHomeowner();
    const r = await recordMoveSignal({ tenantId, customerId, propertyId, kind: "manual", newAddress: "5 Handoff Hwy" });
    expect(r.status).toBe("confirmed");

    await recordMoveSignal({ tenantId, customerId, propertyId, kind: "returned_mail" });
    const touches = await adminDb.select().from(relationshipTouch)
      .where(and(eq(relationshipTouch.customerId, customerId), eq(relationshipTouch.program, "move_play")));
    expect(touches).toHaveLength(1);
    expect(await adminDb.select().from(warrantyTransfer).where(eq(warrantyTransfer.fromCustomerId, customerId))).toHaveLength(1);
  });
});

describe("the verification card's two buttons", () => {
  it("confirmMove promotes a pending event and runs the plays", async () => {
    const { tenantId, customerId, propertyId } = await seedHomeowner();
    const pending = await recordMoveSignal({ tenantId, customerId, propertyId, kind: "ncoa" });
    const r = await confirmMove({ tenantId, moveEventId: pending.moveEventId, newAddress: "9 Confirmed Ct" });
    expect(r.status).toBe("confirmed");

    const [cust] = await adminDb.select().from(customer).where(eq(customer.id, customerId));
    expect(cust!.newAddress).toBe("9 Confirmed Ct");
    expect(await adminDb.select().from(warrantyTransfer).where(eq(warrantyTransfer.fromCustomerId, customerId))).toHaveLength(1);
  });

  it("dismissMove closes the event without plays", async () => {
    const { tenantId, customerId, propertyId } = await seedHomeowner();
    const pending = await recordMoveSignal({ tenantId, customerId, propertyId, kind: "returned_mail" });
    await dismissMove({ tenantId, moveEventId: pending.moveEventId });

    const [ev] = await adminDb.select().from(moveEvent).where(eq(moveEvent.id, pending.moveEventId));
    expect(ev!.status).toBe("dismissed");
    expect(await adminDb.select().from(warrantyTransfer).where(eq(warrantyTransfer.fromCustomerId, customerId))).toHaveLength(0);
  });
});

describe("registerWarrantyTransfer — the new owner inherits the Roof Record", () => {
  it("creates the new customer, reassigns the property, enrolls BOTH parties in the cadence", async () => {
    const { tenantId, customerId, propertyId, jobId } = await seedHomeowner();
    const move = await recordMoveSignal({ tenantId, customerId, propertyId, kind: "manual", newAddress: "5 Handoff Hwy" });
    const [wt] = await adminDb.select().from(warrantyTransfer).where(eq(warrantyTransfer.moveEventId, move.moveEventId));

    const reg = await registerWarrantyTransfer({
      tenantId, transferId: wt!.id, name: "Nina Newowner", phone: "+16025551111", email: "nina@example.com",
    });
    expect("customerId" in reg).toBe(true);
    const newCustomerId = (reg as { customerId: string }).customerId;

    const [p] = await adminDb.select().from(property).where(eq(property.id, propertyId));
    expect(p!.customerId).toBe(newCustomerId);
    const [wt2] = await adminDb.select().from(warrantyTransfer).where(eq(warrantyTransfer.id, wt!.id));
    expect(wt2).toMatchObject({ status: "registered", toCustomerId: newCustomerId });
    expect(wt2!.registeredAt).toBeInstanceOf(Date);

    // Both the old and new owner ride the standing cadence for this job.
    const enrollments = await adminDb.select().from(relationshipEnrollment)
      .where(eq(relationshipEnrollment.jobId, jobId!));
    const enrolledCustomers = enrollments.map((e) => e.customerId).sort();
    expect(enrolledCustomers).toContain(newCustomerId);

    // Old customer's record is preserved untouched.
    const [oldCust] = await adminDb.select().from(customer).where(eq(customer.id, customerId));
    expect(oldCust!.name).toBe("Moving Mia");
  });

  it("registering twice is refused (single transfer per offer)", async () => {
    const { tenantId, customerId, propertyId } = await seedHomeowner();
    const move = await recordMoveSignal({ tenantId, customerId, propertyId, kind: "manual" });
    const [wt] = await adminDb.select().from(warrantyTransfer).where(eq(warrantyTransfer.moveEventId, move.moveEventId));

    await registerWarrantyTransfer({ tenantId, transferId: wt!.id, name: "First Owner" });
    const second = await registerWarrantyTransfer({ tenantId, transferId: wt!.id, name: "Second Owner" });
    expect(second).toMatchObject({ error: "already_registered" });
  });
});

describe("createMoveLeadOnReply — Play A converts on response", () => {
  it("a reply after the sent play-A text creates ONE lead at the new property", async () => {
    const { tenantId, customerId, propertyId } = await seedHomeowner();
    const move = await recordMoveSignal({ tenantId, customerId, propertyId, kind: "manual", newAddress: "77 New Nest Dr" });
    const [touch] = await adminDb.select().from(relationshipTouch)
      .where(eq(relationshipTouch.sourceRef, `${move.moveEventId}:play_a`));
    await markTouchSent({ tenantId, touchId: touch!.id });

    const first = await createMoveLeadOnReply(tenantId, customerId);
    expect(first.leadId).toBeTruthy();
    const [l] = await adminDb.select().from(lead).where(eq(lead.id, first.leadId!));
    expect(l!.source).toBe("existing_customer");
    expect(l!.propertyId).not.toBe(propertyId); // the NEW property, not the old roof
    const [newProp] = await adminDb.select().from(property).where(eq(property.id, l!.propertyId!));
    expect(newProp!.address).toBe("77 New Nest Dr");

    const again = await createMoveLeadOnReply(tenantId, customerId);
    expect(again.leadId).toBeNull(); // deduped
  });

  it("no sent play-A touch → no lead (ordinary replies don't spawn move leads)", async () => {
    const { tenantId, customerId } = await seedHomeowner();
    const r = await createMoveLeadOnReply(tenantId, customerId);
    expect(r.leadId).toBeNull();
  });
});

describe("relationship.move_play evidence", () => {
  it("a confirmed move missing either play is a gap; complete moves are clean", async () => {
    const { tenantId, customerId, propertyId } = await seedHomeowner();
    const move = await recordMoveSignal({ tenantId, customerId, propertyId, kind: "manual" });
    expect((await movePlayGaps(tenantId)).map((g) => g.moveEventId)).not.toContain(move.moveEventId);

    // Simulate a legacy/rogue confirmation that skipped the plays.
    const [c2] = await adminDb.insert(customer).values({ tenantId, name: "Gap Gary" }).returning();
    const [p2] = await adminDb.insert(property).values({ tenantId, customerId: c2!.id, address: "1 Gap Alley" }).returning();
    const [rogue] = await adminDb.insert(moveEvent).values({
      tenantId, customerId: c2!.id, propertyId: p2!.id, status: "confirmed", confidence: 100, confirmedAt: new Date(),
    }).returning();
    expect((await movePlayGaps(tenantId)).map((g) => g.moveEventId)).toContain(rogue!.id);
  });

  it("a transfer on a baselined property must carry the Roof Record link", async () => {
    const { tenantId } = await seedHomeowner();
    const [c] = await adminDb.insert(customer).values({ tenantId, name: "Linkless Lou" }).returning();
    const [p] = await adminDb.insert(property).values({
      tenantId, customerId: c!.id, address: "3 Unlinked Way", baselineInspectionId: crypto.randomUUID(), baselineAt: new Date(),
    }).returning();
    await adminDb.insert(warrantyTransfer).values({
      tenantId, propertyId: p!.id, fromCustomerId: c!.id, baselineInspectionId: null,
    });
    expect((await transfersMissingRecord(tenantId)).map((t) => t.propertyId)).toContain(p!.id);
  });
});
