// Roof Record slice 3: the homeowner's PERMANENT tokenized page. The token
// never expires (the Record is the customer's asset); media renders via
// short-lived signed URLs resolved by the route; no PII rides in URLs.
// Same deterministic id+HMAC family as the estimate link.

import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { createHmac } from "node:crypto";
import { withTenant } from "../tenant";
import { adminDb } from "../admin-client";
import { bookingLink } from "../schema/booking-link";
import { inspection, inspectionZone, inspectionFinding, inspectionMedia } from "../schema/inspection";
import { property } from "../schema/crm";
import { estimate } from "../schema/finance";
import { document } from "../schema/ops";
import { tenant } from "../schema/tenancy";
import { user } from "../schema/tenancy";
import { license } from "../schema/compliance";
import { randomShortCode, roofAgeRange, roofSketchSchema, selectPreferredMeasurement, type RoofAgeRange, type RoofSketch } from "@savvy/core";
import { measurement } from "../schema/ops";

function recordSig(tenantId: string, inspectionId: string): string {
  const secret = process.env.UNSUBSCRIBE_SECRET ?? "dev-unsubscribe-secret";
  return createHmac("sha256", secret).update(`record:${tenantId}:${inspectionId}`).digest("base64url").slice(0, 24);
}

export function recordLinkToken(tenantId: string, inspectionId: string): string {
  return `${inspectionId}.${recordSig(tenantId, inspectionId)}`;
}

/** Mints (or returns) THE permanent page link for a Record. Idempotent. */
export async function ensureRecordLink(input: {
  tenantId: string;
  inspectionId: string;
}): Promise<{ code: string }> {
  const token = recordLinkToken(input.tenantId, input.inspectionId);
  const [existing] = await adminDb.select({ code: bookingLink.code }).from(bookingLink)
    .where(and(eq(bookingLink.tenantId, input.tenantId), eq(bookingLink.kind, "record"), eq(bookingLink.token, token)));
  if (existing) return { code: existing.code };

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomShortCode();
    try {
      await adminDb.insert(bookingLink).values({ tenantId: input.tenantId, code, token, kind: "record" });
      return { code };
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("23505")) continue;
      throw err;
    }
  }
  throw new Error("record link: exhausted short-code attempts");
}

/** Code → verified (tenantId, inspectionId). Null on unknown code or bad signature. */
export async function resolveRecordLink(code: string): Promise<{ tenantId: string; inspectionId: string } | null> {
  const [row] = await adminDb.select({ tenantId: bookingLink.tenantId, token: bookingLink.token }).from(bookingLink)
    .where(and(eq(bookingLink.code, code), eq(bookingLink.kind, "record")));
  if (!row) return null;
  const [inspectionId, sig] = row.token.split(".");
  if (!inspectionId || sig !== recordSig(row.tenantId, inspectionId)) return null;
  return { tenantId: row.tenantId, inspectionId };
}

export type RecordPageZone = {
  zoneKey: string;
  zoneLabel: string;
  zoneKind: string;
  grade: string | null;
  summary: string | null;
  photos: { documentId: string; r2Key: string | null }[];
  findings: {
    id: string;
    whatItIs: string;
    ifIgnored: string | null;
    timeframe: string | null;
    disposition: string;
    repairEstimateCents: number | null;
    photoIds: string[];
  }[];
};

export type RecordPageData = {
  inspectionId: string;
  publishedAt: Date;
  address: string;
  inspectorFirstName: string | null;
  narrative: string | null;
  healthy: boolean;
  zones: RecordPageZone[];
  freeRepairs: RecordPageZone["findings"];
  suggestions: RecordPageZone["findings"];
  replacementDiscussion: boolean;
  ageRange: RoofAgeRange | null;
  companyName: string;
  licenses: { state: string; licenseNumber: string }[];
  estimateId: string | null;
  // The hero: facet polygons from the property's measurement geometry (zone
  // pins color by grade where zone_key matches a facet id). Null → aerial/chip
  // fallback rendering.
  sketch: RoofSketch | null;
};

/**
 * Everything the homeowner page renders — ONLY for a published Record (the
 * approval gate is upstream; unpublished returns null, full stop). Findings are
 * CONFIRMED only; photos are QC-passed only (the customer-safe gate until
 * Production Pulse). Replacement is discussed ONLY when replacement_factor
 * findings exist. No tier pricing, no sales CTAs — the honest suggestions and
 * the estimate link when one exists.
 */
export async function getRecordPageData(input: {
  tenantId: string;
  inspectionId: string;
}): Promise<RecordPageData | null> {
  return withTenant(input.tenantId, async (tx) => {
    const [insp] = await tx.select().from(inspection)
      .where(and(eq(inspection.id, input.inspectionId), eq(inspection.status, "published")));
    if (!insp || !insp.publishedAt) return null;

    const [prop] = await tx.select().from(property).where(eq(property.id, insp.propertyId));
    const inspector = insp.inspectorUserId
      ? (await tx.select({ name: user.name }).from(user).where(eq(user.id, insp.inspectorUserId)))[0]
      : (insp.approvedByUserId
        ? (await tx.select({ name: user.name }).from(user).where(eq(user.id, insp.approvedByUserId)))[0]
        : undefined);

    const zoneRows = await tx.select().from(inspectionZone)
      .where(eq(inspectionZone.inspectionId, input.inspectionId))
      .orderBy(asc(inspectionZone.sortOrder), asc(inspectionZone.createdAt));
    const zoneIds = zoneRows.map((z) => z.id);

    const findingRows = zoneIds.length
      ? await tx.select().from(inspectionFinding)
          .where(and(inArray(inspectionFinding.inspectionZoneId, zoneIds), isNotNull(inspectionFinding.confirmedAt)))
      : [];

    const mediaRows = zoneIds.length
      ? await tx.select({
          zoneId: inspectionMedia.inspectionZoneId,
          documentId: inspectionMedia.documentId,
          r2Key: document.r2Key,
          qcStatus: document.qcStatus,
        }).from(inspectionMedia)
          .innerJoin(document, eq(inspectionMedia.documentId, document.id))
          .where(inArray(inspectionMedia.inspectionZoneId, zoneIds))
      : [];

    const zones: RecordPageZone[] = zoneRows.map((z) => ({
      zoneKey: z.zoneKey,
      zoneLabel: z.zoneLabel,
      zoneKind: z.zoneKind,
      grade: z.grade,
      summary: z.summary,
      photos: mediaRows.filter((m) => m.zoneId === z.id && m.qcStatus === "passed")
        .map((m) => ({ documentId: m.documentId, r2Key: m.r2Key })),
      findings: findingRows.filter((f) => f.inspectionZoneId === z.id).map((f) => ({
        id: f.id, whatItIs: f.whatItIs, ifIgnored: f.ifIgnored, timeframe: f.timeframe,
        disposition: f.disposition, repairEstimateCents: f.repairEstimateCents, photoIds: f.photoIds,
      })),
    }));

    const allFindings = zones.flatMap((z) => z.findings);
    const healthy = zones.length > 0 && zones.every((z) => z.grade === "good");
    const freeRepairs = allFindings.filter((f) => f.disposition === "fixed_free_today");
    const suggestions = allFindings.filter((f) => f.disposition === "repair_quoted" || f.disposition === "replacement_factor");
    const replacementDiscussion = allFindings.some((f) => f.disposition === "replacement_factor");

    const [t] = await tx.select({ name: tenant.name }).from(tenant).where(eq(tenant.id, input.tenantId));
    const licenses = prop?.state
      ? await tx.select({ state: license.state, licenseNumber: license.licenseNumber }).from(license)
          .where(eq(license.state, prop.state))
      : [];

    const measRows = await tx.select({ id: measurement.id, source: measurement.source, createdAt: measurement.createdAt })
      .from(measurement).where(eq(measurement.propertyId, insp.propertyId));
    const preferred = selectPreferredMeasurement(measRows);
    let sketch: RoofSketch | null = null;
    if (preferred) {
      const [m] = await tx.select({ areas: measurement.areas }).from(measurement).where(eq(measurement.id, preferred.id));
      const parsed = roofSketchSchema.safeParse((m?.areas as { sketch?: unknown } | null)?.sketch);
      sketch = parsed.success ? parsed.data : null;
    }

    // The estimate link (never tier pricing — the Record is not the estimate).
    const est = insp.leadId
      ? (await tx.select({ id: estimate.id }).from(estimate)
          .where(and(eq(estimate.leadId, insp.leadId), inArray(estimate.status, ["sent", "accepted"])))
          .limit(1))[0]
      : undefined;

    return {
      inspectionId: insp.id,
      publishedAt: insp.publishedAt,
      address: prop?.address ?? "",
      inspectorFirstName: inspector?.name?.split(/\s+/)[0] ?? null,
      narrative: insp.narrative,
      healthy,
      zones,
      freeRepairs,
      suggestions,
      replacementDiscussion,
      ageRange: prop ? roofAgeRange({
        lastRoofReplacementAt: prop.lastRoofReplacementAt,
        lastRoofReplacementSource: prop.lastRoofReplacementSource,
        yearBuilt: prop.yearBuilt,
      }, new Date()) : null,
      companyName: t?.name ?? "",
      licenses,
      estimateId: est?.id ?? null,
      sketch,
    };
  });
}

export type RecordComparisonZone = {
  zoneKey: string;
  zoneLabel: string;
  beforeGrade: string | null;
  afterGrade: string | null;
  changed: boolean;
  beforePhotos: { documentId: string; r2Key: string | null }[];
  afterPhotos: { documentId: string; r2Key: string | null }[];
};

export type RecordComparison = {
  baselineInspectionId: string;
  baselineAt: Date;
  zones: RecordComparisonZone[];
};

/**
 * Slice 4: the before/after view — a published re-inspection rendered against
 * its baseline, zone by zone (matched on zone_key), side-by-side photos and
 * the grade delta. This is also the claim-evidence artifact carriers see.
 */
export async function getRecordComparison(input: {
  tenantId: string;
  inspectionId: string;
}): Promise<RecordComparison | null> {
  return withTenant(input.tenantId, async (tx) => {
    const [insp] = await tx.select({
      id: inspection.id, status: inspection.status,
      baselineInspectionId: inspection.baselineInspectionId, publishedAt: inspection.publishedAt,
    }).from(inspection).where(eq(inspection.id, input.inspectionId));
    if (!insp || insp.status !== "published" || !insp.baselineInspectionId) return null;

    const [baseline] = await tx.select({ id: inspection.id, publishedAt: inspection.publishedAt })
      .from(inspection)
      .where(and(eq(inspection.id, insp.baselineInspectionId), eq(inspection.status, "published")));
    if (!baseline?.publishedAt) return null;

    async function zonesOf(inspectionId: string) {
      const zones = await tx.select({
        id: inspectionZone.id, zoneKey: inspectionZone.zoneKey,
        zoneLabel: inspectionZone.zoneLabel, grade: inspectionZone.grade,
      }).from(inspectionZone)
        .where(eq(inspectionZone.inspectionId, inspectionId))
        .orderBy(asc(inspectionZone.sortOrder), asc(inspectionZone.createdAt));
      const media = zones.length
        ? await tx.select({
            zoneId: inspectionMedia.inspectionZoneId,
            documentId: inspectionMedia.documentId,
            r2Key: document.r2Key,
            qcStatus: document.qcStatus,
          }).from(inspectionMedia)
            .innerJoin(document, eq(inspectionMedia.documentId, document.id))
            .where(inArray(inspectionMedia.inspectionZoneId, zones.map((z) => z.id)))
        : [];
      return zones.map((z) => ({
        ...z,
        photos: media.filter((m) => m.zoneId === z.id && m.qcStatus === "passed")
          .map((m) => ({ documentId: m.documentId, r2Key: m.r2Key })),
      }));
    }

    const [beforeZones, afterZones] = [await zonesOf(baseline.id), await zonesOf(insp.id)];
    const keys = [...new Set([...beforeZones.map((z) => z.zoneKey), ...afterZones.map((z) => z.zoneKey)])];

    return {
      baselineInspectionId: baseline.id,
      baselineAt: baseline.publishedAt,
      zones: keys.map((key) => {
        const before = beforeZones.find((z) => z.zoneKey === key);
        const after = afterZones.find((z) => z.zoneKey === key);
        return {
          zoneKey: key,
          zoneLabel: after?.zoneLabel ?? before?.zoneLabel ?? key,
          beforeGrade: before?.grade ?? null,
          afterGrade: after?.grade ?? null,
          changed: (before?.grade ?? null) !== (after?.grade ?? null),
          beforePhotos: before?.photos ?? [],
          afterPhotos: after?.photos ?? [],
        };
      }),
    };
  });
}
