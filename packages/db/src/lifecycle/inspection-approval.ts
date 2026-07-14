import { and, eq, isNull, sql } from "drizzle-orm";
import { withTenant } from "../tenant";
import { inspection, inspectionZone, inspectionFinding } from "../schema/index";

/**
 * The inspector approval gate (Roof Record slice 2): pending_approval →
 * approved only by a human (inspector or org admin — the caller authorizes,
 * this stamps who). NOTHING renders to the homeowner before approval, and
 * approval is blocked while unconfirmed ai_suggested findings remain — every
 * AI suggestion is confirmed or dismissed by the inspector first.
 */

export type ApproveResult =
  | { approvedAt: Date }
  | { error: "not_pending_approval" }
  | { error: "unconfirmed_suggestions"; count: number };

export async function approveInspection(input: {
  tenantId: string;
  inspectionId: string;
  userId: string;
}): Promise<ApproveResult> {
  return withTenant(input.tenantId, async (tx) => {
    const [insp] = await tx.select({ status: inspection.status }).from(inspection)
      .where(eq(inspection.id, input.inspectionId));
    if (!insp || insp.status !== "pending_approval") return { error: "not_pending_approval" as const };

    const [pending] = await tx.select({ count: sql<number>`count(*)::int` })
      .from(inspectionFinding)
      .innerJoin(inspectionZone, eq(inspectionFinding.inspectionZoneId, inspectionZone.id))
      .where(and(
        eq(inspectionZone.inspectionId, input.inspectionId),
        eq(inspectionFinding.createdBy, "ai_suggested"),
        isNull(inspectionFinding.confirmedAt),
      ));
    if ((pending?.count ?? 0) > 0) return { error: "unconfirmed_suggestions" as const, count: pending!.count };

    const approvedAt = new Date();
    const [updated] = await tx.update(inspection)
      .set({ status: "approved", approvedAt, approvedByUserId: input.userId })
      .where(and(eq(inspection.id, input.inspectionId), eq(inspection.status, "pending_approval")))
      .returning({ id: inspection.id });
    if (!updated) return { error: "not_pending_approval" as const };
    return { approvedAt };
  });
}

export type PublishResult = { publishedAt: Date } | { error: "not_approved" };

/** approved → published: the Record becomes the homeowner's permanent asset.
 *  (Slice 4 hooks the property baseline onto first publish.) */
export async function publishInspection(input: {
  tenantId: string;
  inspectionId: string;
}): Promise<PublishResult> {
  return withTenant(input.tenantId, async (tx) => {
    const publishedAt = new Date();
    const [updated] = await tx.update(inspection)
      .set({ status: "published", publishedAt })
      .where(and(eq(inspection.id, input.inspectionId), eq(inspection.status, "approved")))
      .returning({ id: inspection.id });
    if (!updated) return { error: "not_approved" as const };
    return { publishedAt };
  });
}

export type SetNarrativeResult =
  | { saved: true }
  | { skipped: "inspector_edited" }
  | { error: "inspection_not_found" };

/**
 * Narrative writes with provenance: AI drafts stamp narrativeDraftedAt; the
 * inspector's edits stamp editor + time. AI/parsed values NEVER overwrite an
 * inspector-confirmed entry (house rule) — once edited, later AI drafts skip.
 */
export async function setInspectionNarrative(input: {
  tenantId: string;
  inspectionId: string;
  narrative: string;
  source: "ai" | "inspector";
  userId?: string | null;
}): Promise<SetNarrativeResult> {
  return withTenant(input.tenantId, async (tx) => {
    const [insp] = await tx.select({ editedBy: inspection.narrativeEditedByUserId }).from(inspection)
      .where(eq(inspection.id, input.inspectionId));
    if (!insp) return { error: "inspection_not_found" as const };

    if (input.source === "ai") {
      if (insp.editedBy) return { skipped: "inspector_edited" as const };
      await tx.update(inspection)
        .set({ narrative: input.narrative, narrativeDraftedAt: new Date() })
        .where(and(eq(inspection.id, input.inspectionId), isNull(inspection.narrativeEditedByUserId)));
      return { saved: true as const };
    }

    await tx.update(inspection)
      .set({ narrative: input.narrative, narrativeEditedByUserId: input.userId ?? null, narrativeEditedAt: new Date() })
      .where(eq(inspection.id, input.inspectionId));
    return { saved: true as const };
  });
}

/** AI zone summaries: written only while the zone summary is untouched-by-human
 *  is not tracked per-zone — the whole-Record approval gate is the human control. */
export async function setZoneSummaries(input: {
  tenantId: string;
  inspectionId: string;
  summaries: { zoneKey: string; summary: string }[];
}): Promise<{ updated: number }> {
  return withTenant(input.tenantId, async (tx) => {
    let updated = 0;
    for (const s of input.summaries) {
      const res = await tx.update(inspectionZone)
        .set({ summary: s.summary })
        .where(and(eq(inspectionZone.inspectionId, input.inspectionId), eq(inspectionZone.zoneKey, s.zoneKey)))
        .returning({ id: inspectionZone.id });
      updated += res.length;
    }
    return { updated };
  });
}
