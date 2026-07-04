import { adminDb } from "../admin-client";
import { withTenant } from "../tenant";
import { property, job, document, auditLog } from "../schema/index";
import { tenant } from "../schema/index";
import { eq, and, desc, sql, isNull, isNotNull, ne } from "drizzle-orm";
import { normalizeAddressForMatch } from "@savvy/core";

const CLOSED_STAGES = ["complete", "lost"] as const;

/** Resolve the Savvy job a photo belongs to by matching its property address.
 *  Prefers the most recent open (non-complete/lost) job; else the newest job. */
export async function resolvePhotoJob(input: { tenantId: string; address: string }): Promise<{ jobId: string } | null> {
  const norm = normalizeAddressForMatch(input.address);
  return withTenant(input.tenantId, async (tx) => {
    // Normalize property addresses in SQL the same way (lower + strip . , # + collapse spaces).
    // Suffix-word standardization is not reproduced in SQL; we compare on the cleaned form and
    // rely on normalizeAddressForMatch-equal inputs. Fetch candidates, then match in JS for parity.
    const props = await tx.select({ id: property.id, address: property.address }).from(property);
    const match = props.find((p) => normalizeAddressForMatch(p.address) === norm);
    if (!match) return null;
    const jobs = await tx.select({ id: job.id, stage: job.stage, createdAt: job.createdAt })
      .from(job).where(eq(job.propertyId, match.id)).orderBy(desc(job.createdAt));
    if (jobs.length === 0) return null;
    const open = jobs.find((j) => !CLOSED_STAGES.includes(j.stage as (typeof CLOSED_STAGES)[number]));
    return { jobId: (open ?? jobs[0]!).id };
  });
}

/** Resolve a tenant by its SiteSnap ingestion key (settings.sitesnap.ingestKey). Admin path. */
export async function resolveTenantByIngestKey(key: string): Promise<{ tenantId: string } | null> {
  if (!key) return null;
  const [row] = await adminDb.select({ id: tenant.id })
    .from(tenant)
    .where(sql`${tenant.settings} #>> '{sitesnap,ingestKey}' = ${key}`);
  return row ? { tenantId: row.id } : null;
}

/** Idempotent insert of a SiteSnap photo document. Repeat (tenant, sitesnapPhotoId) → no-op. */
export async function recordSiteSnapPhoto(input: {
  tenantId: string; jobId: string | null; category: string;
  r2Key: string; captureAddress: string; sitesnapPhotoId: string;
}): Promise<{ created: boolean; documentId: string }> {
  return withTenant(input.tenantId, async (tx) => {
    // Fast path: return the existing row if this photo was already ingested.
    const [existing] = await tx.select({ id: document.id }).from(document)
      .where(and(eq(document.tenantId, input.tenantId), eq(document.sitesnapPhotoId, input.sitesnapPhotoId)));
    if (existing) return { created: false, documentId: existing.id };

    // Atomic insert: a concurrent duplicate loses the race to the partial-unique
    // index and inserts nothing (onConflictDoNothing) rather than throwing 23505.
    const inserted = await tx.insert(document).values({
      tenantId: input.tenantId, jobId: input.jobId, kind: "photo", source: "sitesnap",
      label: input.category, r2Key: input.r2Key, captureAddress: input.captureAddress,
      sitesnapPhotoId: input.sitesnapPhotoId, qcStatus: "pending",
    }).onConflictDoNothing().returning({ id: document.id });
    if (inserted[0]) return { created: true, documentId: inserted[0].id };

    // Lost the race: the winner's row now exists — return it as created:false.
    const [winner] = await tx.select({ id: document.id }).from(document)
      .where(and(eq(document.tenantId, input.tenantId), eq(document.sitesnapPhotoId, input.sitesnapPhotoId)));
    return { created: false, documentId: winner!.id };
  });
}

/** SiteSnap photos with no job (address didn't match) — the unmatched tray. */
export async function listUnmatchedPhotos(tenantId: string): Promise<{ id: string; captureAddress: string | null; label: string | null; createdAt: Date }[]> {
  return withTenant(tenantId, (tx) => tx.select({
    id: document.id, captureAddress: document.captureAddress, label: document.label, createdAt: document.createdAt,
  }).from(document).where(and(eq(document.source, "sitesnap"), isNull(document.jobId))));
}

/** Manually attach an unmatched photo to a job (from the tray). */
export async function matchPhotoToJob(input: { tenantId: string; documentId: string; jobId: string }): Promise<void> {
  await withTenant(input.tenantId, (tx) => tx.update(document).set({ jobId: input.jobId })
    .where(and(eq(document.id, input.documentId), eq(document.tenantId, input.tenantId))));
}

/** Fetch the QC-relevant fields of a single photo document. Returns null if not found. */
export async function getPhotoForQc(input: { tenantId: string; documentId: string }): Promise<{ jobId: string | null; r2Key: string | null; label: string | null; qcStatus: string | null } | null> {
  return withTenant(input.tenantId, async (tx) => {
    const [d] = await tx.select({ jobId: document.jobId, r2Key: document.r2Key, label: document.label, qcStatus: document.qcStatus })
      .from(document).where(and(eq(document.id, input.documentId), eq(document.kind, "photo")));
    return d ?? null;
  });
}

/** Return other photos on the same job that already have a perceptual hash (for duplicate detection). */
export async function getJobPhotoHashes(input: { tenantId: string; jobId: string; excludeDocumentId: string }): Promise<{ documentId: string; phash: string }[]> {
  return withTenant(input.tenantId, async (tx) => {
    const rows = await tx.select({ documentId: document.id, phash: document.phash })
      .from(document).where(and(
        eq(document.jobId, input.jobId),
        eq(document.kind, "photo"),
        isNotNull(document.phash),
        ne(document.id, input.excludeDocumentId),
      ));
    return rows.filter((r): r is { documentId: string; phash: string } => r.phash != null);
  });
}

/** Persist the QC result for a photo document. */
export async function setPhotoQc(input: { tenantId: string; documentId: string; phash: string | null; qcStatus: string; qcReasons: unknown }): Promise<void> {
  await withTenant(input.tenantId, (tx) => tx.update(document)
    .set({ phash: input.phash, qcStatus: input.qcStatus, qcReasons: input.qcReasons })
    .where(and(eq(document.id, input.documentId), eq(document.tenantId, input.tenantId))));
}

/** Return all flagged photo documents for the tenant with a human-readable reason string. */
export async function listFlaggedPhotos(tenantId: string): Promise<{ documentId: string; jobId: string; label: string | null; reason: string; occurredAt: Date }[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.select({ id: document.id, jobId: document.jobId, label: document.label, qcReasons: document.qcReasons, createdAt: document.createdAt })
      .from(document).where(and(
        eq(document.kind, "photo"),
        eq(document.qcStatus, "flagged"),
        isNotNull(document.jobId),
      ));
    return rows.map((r) => ({
      documentId: r.id, jobId: r.jobId!, label: r.label,
      reason: reasonText(r.qcReasons), occurredAt: r.createdAt,
    }));
  });
}

/** Turn the structured qcReasons object into a short human string for the exception detail. */
function reasonText(raw: unknown): string {
  const r = (raw ?? {}) as { quality?: string; wrongCategory?: boolean; duplicateOf?: string };
  const parts: string[] = [];
  if (r.quality) parts.push(r.quality);
  if (r.wrongCategory) parts.push("wrong category");
  if (r.duplicateOf) parts.push("duplicate");
  return parts.join(", ") || "flagged";
}

/** Flagged photos on ONE job, for the job page's resolution panel. reason via reasonText. */
export async function listFlaggedPhotosForJob(
  tenantId: string,
  jobId: string,
): Promise<{ documentId: string; label: string | null; reason: string }[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({ id: document.id, label: document.label, qcReasons: document.qcReasons })
      .from(document)
      .where(and(eq(document.jobId, jobId), eq(document.kind, "photo"), eq(document.qcStatus, "flagged")))
      .orderBy(desc(document.createdAt));
    return rows.map((r) => ({ documentId: r.id, label: r.label, reason: reasonText(r.qcReasons) }));
  });
}

/**
 * Accept a flagged photo: flip qc_status flagged→passed AND record a photo_qc_kept
 * audit entry, atomically. The WHERE guard (flagged + non-null job + tenant) makes this
 * idempotent and safe — a non-flagged/missing/other-tenant doc updates 0 rows → null, no audit.
 */
export async function keepFlaggedPhoto(input: {
  tenantId: string;
  userId: string | null;
  documentId: string;
}): Promise<{ jobId: string } | null> {
  return withTenant(input.tenantId, async (tx) => {
    const [updated] = await tx
      .update(document)
      .set({ qcStatus: "passed" })
      .where(
        and(
          eq(document.id, input.documentId),
          eq(document.tenantId, input.tenantId),
          eq(document.kind, "photo"),
          eq(document.qcStatus, "flagged"),
          isNotNull(document.jobId),
        ),
      )
      .returning({ jobId: document.jobId, qcReasons: document.qcReasons });
    if (!updated || !updated.jobId) return null;
    await tx.insert(auditLog).values({
      tenantId: input.tenantId,
      userId: input.userId,
      entityType: "document",
      entityId: input.documentId,
      action: "photo_qc_kept",
      diff: { from: "flagged", reasons: (updated.qcReasons ?? {}) as Record<string, unknown> },
    });
    return { jobId: updated.jobId };
  });
}
