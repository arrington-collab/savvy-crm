import { adminDb } from "../admin-client";
import { withTenant } from "../tenant";
import { property, job, document } from "../schema/index";
import { tenant } from "../schema/index";
import { eq, and, desc, sql, isNull } from "drizzle-orm";
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
