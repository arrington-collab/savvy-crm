import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { withTenant } from "../tenant";
import { lead, property, inspection, inspectionZone, inspectionMedia } from "../schema/index";
import { normalizeAddressForMatch } from "@savvy/core";
import { accrueInspectionStandardCostTx } from "./partner-ledger";

// Media is accepted while capture is live and during the approval window (late
// BloomCam outbox retries land after the inspector climbs down); it is refused
// once the Record is approved/published — the homeowner-facing artifact is frozen.
const MEDIA_OPEN_STATUSES = ["in_progress", "pending_approval"] as const;

export type StartInspectionResult =
  | { created: boolean; inspectionId: string }
  | { error: "lead_not_found" };

/**
 * Instantiate an inspection when the inspector starts capture (BloomCam event →
 * Savvy) or manually from the lead tile. Idempotent per lead: an in_progress
 * inspection is reused so a retried start event never forks a second Record.
 */
export async function startInspectionForLead(input: {
  tenantId: string;
  leadId: string;
  inspectorUserId?: string | null;
  kind?: string;
}): Promise<StartInspectionResult> {
  return withTenant(input.tenantId, async (tx) => {
    const [l] = await tx.select({ id: lead.id, propertyId: lead.propertyId }).from(lead)
      .where(eq(lead.id, input.leadId));
    if (!l || !l.propertyId) return { error: "lead_not_found" as const };

    const [existing] = await tx.select({ id: inspection.id }).from(inspection)
      .where(and(eq(inspection.leadId, input.leadId), eq(inspection.status, "in_progress")));
    if (existing) return { created: false, inspectionId: existing.id };

    const kind = input.kind ?? "initial";
    // Non-initial inspections compare against the property's baseline — the
    // before/after view is the claim-evidence artifact (slice 4).
    let baselineInspectionId: string | null = null;
    if (kind !== "initial") {
      const [prop] = await tx.select({ baselineInspectionId: property.baselineInspectionId })
        .from(property).where(eq(property.id, l.propertyId));
      baselineInspectionId = prop?.baselineInspectionId ?? null;
    }

    const [created] = await tx.insert(inspection).values({
      tenantId: input.tenantId,
      leadId: input.leadId,
      propertyId: l.propertyId,
      inspectorUserId: input.inspectorUserId ?? null,
      kind,
      baselineInspectionId,
    }).returning({ id: inspection.id });
    return { created: true, inspectionId: created!.id };
  });
}

const OPEN_LEAD_STATUSES = ["new", "contacted", "qualified", "booked"] as const;

/**
 * BloomCam's start-capture event carries an address, not a lead id. Resolve the
 * newest OPEN lead at that address (same normalization as the photo pipe) and
 * start — or resume — its inspection. The webhook response returns the
 * inspection id BloomCam then stamps on every media event.
 */
export async function startInspectionByAddress(input: {
  tenantId: string;
  address: string;
  inspectorUserId?: string | null;
}): Promise<StartInspectionResult | { error: "no_lead_match" }> {
  const norm = normalizeAddressForMatch(input.address);
  const leadId = await withTenant(input.tenantId, async (tx) => {
    const props = await tx.select({ id: property.id, address: property.address }).from(property);
    const match = props.find((p) => normalizeAddressForMatch(p.address) === norm);
    if (!match) return null;
    const [openLead] = await tx.select({ id: lead.id }).from(lead)
      .where(and(eq(lead.propertyId, match.id), inArray(lead.status, [...OPEN_LEAD_STATUSES])))
      .orderBy(desc(lead.createdAt))
      .limit(1);
    return openLead?.id ?? null;
  });
  if (!leadId) return { error: "no_lead_match" as const };
  return startInspectionForLead({ tenantId: input.tenantId, leadId, inspectorUserId: input.inspectorUserId });
}

/** Scope lookup for the ingestion pipe: media documents inherit the
 *  inspection's lead so QC + the lead photo rail see them. */
export async function getInspectionScope(input: {
  tenantId: string;
  inspectionId: string;
}): Promise<{ leadId: string | null; propertyId: string; status: string } | null> {
  return withTenant(input.tenantId, async (tx) => {
    const [row] = await tx.select({ leadId: inspection.leadId, propertyId: inspection.propertyId, status: inspection.status })
      .from(inspection).where(eq(inspection.id, input.inspectionId));
    return row ?? null;
  });
}

export type IngestMediaResult =
  | { inspectionZoneId: string; documentId: string; created: boolean }
  | { error: "inspection_not_found" | "inspection_closed" };

/**
 * Land one zone-tagged media event on its zone. The zone is upserted by
 * (inspection_id, zone_key) — BloomCam's selected section is the source of zone
 * truth. Replays (outbox retries) are no-ops via the (inspection_id, document_id)
 * unique index. GPS is stored as a sanity check only — never used for placement.
 */
export async function ingestInspectionMedia(input: {
  tenantId: string;
  inspectionId: string;
  zoneKey: string;
  zoneLabel: string;
  zoneKind?: string;
  documentId: string;
  checklistItemKey?: string | null;
  checklistVersionRef?: string | null;
  capturedAt?: Date | null;
  gps?: { lat: number; lng: number } | null;
  note?: string | null;
}): Promise<IngestMediaResult> {
  return withTenant(input.tenantId, async (tx) => {
    const [insp] = await tx.select({ id: inspection.id, status: inspection.status }).from(inspection)
      .where(eq(inspection.id, input.inspectionId));
    if (!insp) return { error: "inspection_not_found" as const };
    if (!MEDIA_OPEN_STATUSES.includes(insp.status as (typeof MEDIA_OPEN_STATUSES)[number])) {
      return { error: "inspection_closed" as const };
    }

    // Zone upsert: concurrent first-media events race to the unique index;
    // the loser's insert is a no-op and the follow-up select wins either way.
    let [zone] = await tx.select({ id: inspectionZone.id }).from(inspectionZone)
      .where(and(eq(inspectionZone.inspectionId, input.inspectionId), eq(inspectionZone.zoneKey, input.zoneKey)));
    if (!zone) {
      const [maxSort] = await tx.select({ max: sql<number>`coalesce(max(${inspectionZone.sortOrder}), -1)` })
        .from(inspectionZone).where(eq(inspectionZone.inspectionId, input.inspectionId));
      const inserted = await tx.insert(inspectionZone).values({
        tenantId: input.tenantId,
        inspectionId: input.inspectionId,
        zoneKey: input.zoneKey,
        zoneLabel: input.zoneLabel,
        zoneKind: input.zoneKind ?? "other",
        sortOrder: (maxSort?.max ?? -1) + 1,
        checklistVersionRef: input.checklistVersionRef ?? null,
      }).onConflictDoNothing().returning({ id: inspectionZone.id });
      zone = inserted[0] ?? (await tx.select({ id: inspectionZone.id }).from(inspectionZone)
        .where(and(eq(inspectionZone.inspectionId, input.inspectionId), eq(inspectionZone.zoneKey, input.zoneKey))))[0];
    }

    const insertedMedia = await tx.insert(inspectionMedia).values({
      tenantId: input.tenantId,
      inspectionId: input.inspectionId,
      inspectionZoneId: zone!.id,
      documentId: input.documentId,
      checklistItemKey: input.checklistItemKey ?? null,
      capturedAt: input.capturedAt ?? null,
      gpsLat: input.gps ? String(input.gps.lat) : null,
      gpsLng: input.gps ? String(input.gps.lng) : null,
    }).onConflictDoNothing().returning({ id: inspectionMedia.id });

    const created = insertedMedia.length > 0;

    // Capture note → the zone's inspector notes. Gated on the media insert
    // winning, so an outbox replay can never append the same note twice.
    // (AI voice-memo parse is slice 2; source stays 'capture' here.)
    if (created && input.note?.trim()) {
      await tx.update(inspectionZone).set({
        inspectorNotes: sql`${inspectionZone.inspectorNotes} || ${JSON.stringify([
          { text: input.note.trim(), at: new Date().toISOString(), source: "capture" },
        ])}::jsonb`,
      }).where(eq(inspectionZone.id, zone!.id));
    }

    return { inspectionZoneId: zone!.id, documentId: input.documentId, created };
  });
}

export type CompleteInspectionResult = { completedAt: Date } | { error: "not_in_progress" };

/** The inspector climbs down: in_progress → pending_approval. One-way; replays refuse. */
export async function completeInspection(input: {
  tenantId: string;
  inspectionId: string;
}): Promise<CompleteInspectionResult> {
  return withTenant(input.tenantId, async (tx) => {
    const completedAt = new Date();
    const [updated] = await tx.update(inspection)
      .set({ status: "pending_approval", completedAt })
      .where(and(eq(inspection.id, input.inspectionId), eq(inspection.status, "in_progress")))
      .returning({ id: inspection.id });
    if (!updated) return { error: "not_in_progress" as const };
    // Partner Ledger: a completed inspection on a partner-sourced lead costs
    // real time — accrue the tenant standard cost (idempotent on source_ref).
    await accrueInspectionStandardCostTx(tx, input.tenantId, input.inspectionId);
    return { completedAt };
  });
}

/** The lead page card: the lead's inspection while it's inside the capture/
 *  approval window (in_progress or pending_approval). Null once approved. */
export async function getActiveInspectionForLead(input: {
  tenantId: string;
  leadId: string;
}): Promise<InspectionProgress | null> {
  const inspectionId = await withTenant(input.tenantId, async (tx) => {
    const [row] = await tx.select({ id: inspection.id }).from(inspection)
      .where(and(eq(inspection.leadId, input.leadId), inArray(inspection.status, [...MEDIA_OPEN_STATUSES])))
      .orderBy(desc(inspection.startedAt))
      .limit(1);
    return row?.id ?? null;
  });
  if (!inspectionId) return null;
  return getInspectionProgress({ tenantId: input.tenantId, inspectionId });
}

export type InspectionProgress = {
  inspectionId: string;
  status: string;
  leadId: string | null;
  zones: {
    zoneKey: string;
    zoneLabel: string;
    zoneKind: string;
    grade: string | null;
    photoCount: number;
  }[];
};

/** Live progress for the lead tile's "Inspection in progress — 4/9 zones" card. */
export async function getInspectionProgress(input: {
  tenantId: string;
  inspectionId: string;
}): Promise<InspectionProgress | null> {
  return withTenant(input.tenantId, async (tx) => {
    const [insp] = await tx.select({ id: inspection.id, status: inspection.status, leadId: inspection.leadId })
      .from(inspection).where(eq(inspection.id, input.inspectionId));
    if (!insp) return null;

    const zones = await tx.select({
      id: inspectionZone.id,
      zoneKey: inspectionZone.zoneKey,
      zoneLabel: inspectionZone.zoneLabel,
      zoneKind: inspectionZone.zoneKind,
      grade: inspectionZone.grade,
    }).from(inspectionZone)
      .where(eq(inspectionZone.inspectionId, input.inspectionId))
      .orderBy(asc(inspectionZone.sortOrder), asc(inspectionZone.createdAt));

    const counts = zones.length
      ? await tx.select({
          zoneId: inspectionMedia.inspectionZoneId,
          count: sql<number>`count(*)::int`,
        }).from(inspectionMedia)
          .where(inArray(inspectionMedia.inspectionZoneId, zones.map((z) => z.id)))
          .groupBy(inspectionMedia.inspectionZoneId)
      : [];
    const countByZone = new Map(counts.map((c) => [c.zoneId, c.count]));

    return {
      inspectionId: insp.id,
      status: insp.status,
      leadId: insp.leadId,
      zones: zones.map((z) => ({
        zoneKey: z.zoneKey,
        zoneLabel: z.zoneLabel,
        zoneKind: z.zoneKind,
        grade: z.grade,
        photoCount: countByZone.get(z.id) ?? 0,
      })),
    };
  });
}
