// Customer for Life slice 3: the move double-play. Signals accumulate on one
// open move_event; the pure confidence math (core) decides confirmed vs
// verification card — a single soft signal never confirms. A confirmed move
// runs BOTH plays idempotently: Play A (governed move_play touch to the
// customer — their Roof Record rides with them) and Play B (warranty-transfer
// offer to the old address's new owner, letter held for PostGrid). The
// relationship.move_play evidence reads all of it.

import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { withTenant } from "../tenant";
import { tenant, customer, property, job, lead, moveEvent, warrantyTransfer, relationshipEnrollment, relationshipTouch } from "../schema/index";
import { parseMovePlayConfig, moveConfidence, moveVerdict } from "@savvy/core";
import { scheduleRelationshipTouch } from "./relationship-touch";

const DAY = 86_400_000;
const REPLY_WINDOW_MS = 30 * DAY;

type MoveSignalInput = {
  tenantId: string;
  customerId: string;
  propertyId: string;
  kind: "ncoa" | "returned_mail" | "manual";
  detail?: string;
  newAddress?: string;
  now?: Date;
};

export type MoveSignalResult = { moveEventId: string; status: string; confidence: number };

async function movePlayConfig(tenantId: string) {
  const [t] = await withTenant(tenantId, (tx) =>
    tx.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId)));
  return parseMovePlayConfig((t?.settings as { movePlay?: unknown } | null)?.movePlay);
}

/** Both plays, idempotent: Play A dedupes on the governor's (program, sourceRef);
 *  Play B dedupes on one warranty_transfer per move_event. */
async function runMovePlays(input: { tenantId: string; moveEventId: string; now: Date }): Promise<void> {
  const ev = await withTenant(input.tenantId, async (tx) => {
    const [e] = await tx.select().from(moveEvent).where(eq(moveEvent.id, input.moveEventId));
    return e ?? null;
  });
  if (!ev || ev.status !== "confirmed") return;

  await scheduleRelationshipTouch({
    tenantId: input.tenantId, customerId: ev.customerId, program: "move_play", channel: "text",
    scheduledFor: input.now, sourceRef: `${ev.id}:play_a`, now: input.now,
  });

  await withTenant(input.tenantId, async (tx) => {
    const [existing] = await tx.select({ id: warrantyTransfer.id }).from(warrantyTransfer)
      .where(eq(warrantyTransfer.moveEventId, ev.id));
    if (existing) return;
    const [prop] = await tx.select({ baselineInspectionId: property.baselineInspectionId })
      .from(property).where(eq(property.id, ev.propertyId));
    await tx.insert(warrantyTransfer).values({
      tenantId: input.tenantId, propertyId: ev.propertyId, fromCustomerId: ev.customerId,
      moveEventId: ev.id, baselineInspectionId: prop?.baselineInspectionId ?? null,
    });
  });
}

async function confirmEvent(input: { tenantId: string; eventId: string; newAddress?: string | null; now: Date }): Promise<void> {
  await withTenant(input.tenantId, async (tx) => {
    const [ev] = await tx.update(moveEvent)
      .set({ status: "confirmed", confirmedAt: input.now, ...(input.newAddress ? { newAddress: input.newAddress } : {}) })
      .where(eq(moveEvent.id, input.eventId))
      .returning();
    if (!ev) return;
    await tx.update(customer)
      .set({ movedAt: input.now, ...(ev.newAddress ? { newAddress: ev.newAddress } : {}) })
      .where(eq(customer.id, ev.customerId));
  });
  await runMovePlays({ tenantId: input.tenantId, moveEventId: input.eventId, now: input.now });
}

/** The PostGrid seam's inlet (NCOA / returned mail) and the manual action.
 *  Appends to the customer+property's open event and re-scores. */
export async function recordMoveSignal(input: MoveSignalInput): Promise<MoveSignalResult> {
  const now = input.now ?? new Date();
  const cfg = await movePlayConfig(input.tenantId);

  const ev = await withTenant(input.tenantId, async (tx) => {
    const [open] = await tx.select().from(moveEvent)
      .where(and(
        eq(moveEvent.customerId, input.customerId),
        eq(moveEvent.propertyId, input.propertyId),
        inArray(moveEvent.status, ["detected", "pending_verification", "confirmed"]),
      ))
      .orderBy(desc(moveEvent.createdAt)).limit(1);

    const signal = { kind: input.kind, ...(input.detail ? { detail: input.detail } : {}), at: now.toISOString() };
    if (open) {
      const signals = [...open.signals, signal];
      const [updated] = await tx.update(moveEvent)
        .set({
          signals, confidence: moveConfidence(signals),
          ...(input.newAddress ? { newAddress: input.newAddress } : {}),
        })
        .where(eq(moveEvent.id, open.id)).returning();
      return updated!;
    }
    const signals = [signal];
    const [created] = await tx.insert(moveEvent).values({
      tenantId: input.tenantId, customerId: input.customerId, propertyId: input.propertyId,
      signals, confidence: moveConfidence(signals), newAddress: input.newAddress ?? null,
    }).returning();
    return created!;
  });

  if (ev.status === "confirmed") {
    // Already confirmed: plays are idempotent — re-running self-heals gaps.
    await runMovePlays({ tenantId: input.tenantId, moveEventId: ev.id, now });
    return { moveEventId: ev.id, status: "confirmed", confidence: ev.confidence };
  }

  if (moveVerdict(ev.confidence, cfg.confidenceThreshold) === "confirm") {
    await confirmEvent({ tenantId: input.tenantId, eventId: ev.id, now });
    return { moveEventId: ev.id, status: "confirmed", confidence: ev.confidence };
  }

  await withTenant(input.tenantId, (tx) =>
    tx.update(moveEvent).set({ status: "pending_verification" }).where(eq(moveEvent.id, ev.id)));
  return { moveEventId: ev.id, status: "pending_verification", confidence: ev.confidence };
}

/** The verification card's YES button (and the manual-confirm path). */
export async function confirmMove(input: { tenantId: string; moveEventId: string; newAddress?: string; now?: Date }): Promise<{ status: string }> {
  const now = input.now ?? new Date();
  await confirmEvent({ tenantId: input.tenantId, eventId: input.moveEventId, newAddress: input.newAddress ?? null, now });
  return { status: "confirmed" };
}

/** The verification card's NO button. */
export async function dismissMove(input: { tenantId: string; moveEventId: string }): Promise<void> {
  await withTenant(input.tenantId, (tx) =>
    tx.update(moveEvent).set({ status: "dismissed" }).where(eq(moveEvent.id, input.moveEventId)));
}

/** Pending verification cards for /today. */
export async function pendingMoveVerifications(tenantId: string) {
  return withTenant(tenantId, (tx) =>
    tx.select({
      moveEventId: moveEvent.id, customerId: moveEvent.customerId, confidence: moveEvent.confidence,
      newAddress: moveEvent.newAddress, signals: moveEvent.signals, createdAt: moveEvent.createdAt,
      customerName: customer.name, address: property.address,
    })
      .from(moveEvent)
      .innerJoin(customer, eq(customer.id, moveEvent.customerId))
      .innerJoin(property, eq(property.id, moveEvent.propertyId))
      .where(eq(moveEvent.status, "pending_verification")));
}

export type RegisterTransferResult = { customerId: string } | { error: "not_found" | "already_registered" };

/** Play B lands: the new owner registers, becomes a customer, inherits the
 *  property (and with it the Roof Record); both parties ride the cadence. */
export async function registerWarrantyTransfer(input: {
  tenantId: string; transferId: string; name: string; phone?: string; email?: string; now?: Date;
}): Promise<RegisterTransferResult> {
  const now = input.now ?? new Date();
  return withTenant(input.tenantId, async (tx) => {
    const [wt] = await tx.select().from(warrantyTransfer).where(eq(warrantyTransfer.id, input.transferId));
    if (!wt) return { error: "not_found" as const };
    if (wt.toCustomerId) return { error: "already_registered" as const };

    const [newCust] = await tx.insert(customer).values({
      tenantId: input.tenantId, name: input.name, phone: input.phone ?? null, email: input.email ?? null,
      emailSource: input.email ? "self_reported" : null,
      // Implied consent (business-relationship basis) — the new owner is
      // registering into an active warranty-transfer relationship, not a cold
      // contact. See packages/db/src/scripts/backfill-implied-consent.ts.
      smsConsentAt: input.phone ? sql`now()` : null,
    }).returning();

    await tx.update(property).set({ customerId: newCust!.id }).where(eq(property.id, wt.propertyId));
    await tx.update(warrantyTransfer)
      .set({ toCustomerId: newCust!.id, status: "registered", registeredAt: now })
      .where(eq(warrantyTransfer.id, wt.id));

    // Enroll the new owner against the property's completed job — the standing
    // cadence (roofiversary, holiday card) now watches their roof too.
    const [doneJob] = await tx.select({ id: job.id, completedAt: job.stageEnteredAt }).from(job)
      .where(and(eq(job.propertyId, wt.propertyId), eq(job.stage, "complete")))
      .orderBy(desc(job.stageEnteredAt)).limit(1);
    if (doneJob) {
      await tx.insert(relationshipEnrollment).values({
        tenantId: input.tenantId, customerId: newCust!.id, jobId: doneJob.id,
        completedAt: doneJob.completedAt, enrolledAt: now,
      }).onConflictDoNothing();
    }
    return { customerId: newCust!.id };
  });
}

/** Public transfer page data (token → transferId happens at the web layer). */
export async function getWarrantyTransferOffer(tenantId: string, transferId: string) {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.select({
      transferId: warrantyTransfer.id, status: warrantyTransfer.status,
      baselineInspectionId: warrantyTransfer.baselineInspectionId,
      address: property.address, baselineAt: property.baselineAt,
      lastRoofReplacementAt: property.lastRoofReplacementAt,
      companyName: tenant.name,
    })
      .from(warrantyTransfer)
      .innerJoin(property, eq(property.id, warrantyTransfer.propertyId))
      .innerJoin(tenant, eq(tenant.id, warrantyTransfer.tenantId))
      .where(eq(warrantyTransfer.id, transferId));
    return rows[0] ?? null;
  });
}

/** Play A converts on response: an inbound reply within the window after a SENT
 *  play-A touch creates ONE lead at the customer's new address. */
export async function createMoveLeadOnReply(
  tenantId: string, customerId: string, now: Date = new Date(),
): Promise<{ leadId: string | null }> {
  return withTenant(tenantId, async (tx) => {
    const cutoff = new Date(now.getTime() - REPLY_WINDOW_MS);
    const [touch] = await tx.select().from(relationshipTouch)
      .where(and(
        eq(relationshipTouch.customerId, customerId),
        eq(relationshipTouch.program, "move_play"),
        isNotNull(relationshipTouch.sentAt),
        sql`${relationshipTouch.sentAt} >= ${cutoff.toISOString()}::timestamptz`,
        sql`${relationshipTouch.sourceRef} like '%:play_a'`,
      ))
      .orderBy(desc(relationshipTouch.sentAt)).limit(1);
    if (!touch?.sourceRef) return { leadId: null };
    const moveEventId = touch.sourceRef.split(":")[0]!;

    const [dupe] = await tx.select({ id: lead.id }).from(lead)
      .where(and(
        eq(lead.customerId, customerId),
        sql`${lead.sourceDetail}->>'moveEventId' = ${moveEventId}`,
      ));
    if (dupe) return { leadId: null };

    const [ev] = await tx.select({ newAddress: moveEvent.newAddress }).from(moveEvent).where(eq(moveEvent.id, moveEventId));
    const [newProp] = await tx.insert(property).values({
      tenantId, customerId, address: ev?.newAddress ?? "new address (pending)",
    }).returning();
    const [created] = await tx.insert(lead).values({
      tenantId, customerId, propertyId: newProp!.id,
      source: "existing_customer", sourceDetail: { moveEventId },
    }).returning({ id: lead.id });
    return { leadId: created!.id };
  });
}

/** relationship.move_play evidence: every confirmed move produced BOTH plays
 *  (Play A touch row in any state — refusals count as logged suppression —
 *  and a warranty_transfer offer). Must be empty. */
export async function movePlayGaps(tenantId: string): Promise<{ moveEventId: string }[]> {
  return withTenant(tenantId, async (tx) => {
    const confirmed = await tx.select({ id: moveEvent.id, customerId: moveEvent.customerId })
      .from(moveEvent).where(eq(moveEvent.status, "confirmed"));
    if (confirmed.length === 0) return [];
    const gaps: { moveEventId: string }[] = [];
    for (const ev of confirmed) {
      const [playA] = await tx.select({ id: relationshipTouch.id }).from(relationshipTouch)
        .where(and(eq(relationshipTouch.customerId, ev.customerId), eq(relationshipTouch.sourceRef, `${ev.id}:play_a`)));
      const [playB] = await tx.select({ id: warrantyTransfer.id }).from(warrantyTransfer)
        .where(eq(warrantyTransfer.moveEventId, ev.id));
      if (!playA || !playB) gaps.push({ moveEventId: ev.id });
    }
    return gaps;
  });
}

/** relationship.move_play evidence: a transfer on a baselined property always
 *  links the Roof Record. Must be empty. */
export async function transfersMissingRecord(tenantId: string): Promise<{ transferId: string; propertyId: string }[]> {
  return withTenant(tenantId, (tx) =>
    tx.select({ transferId: warrantyTransfer.id, propertyId: warrantyTransfer.propertyId })
      .from(warrantyTransfer)
      .innerJoin(property, eq(property.id, warrantyTransfer.propertyId))
      .where(and(
        isNotNull(property.baselineInspectionId),
        sql`${warrantyTransfer.baselineInspectionId} is distinct from ${property.baselineInspectionId}`,
      )));
}
