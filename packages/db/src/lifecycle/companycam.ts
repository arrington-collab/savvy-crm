import { and, eq } from "drizzle-orm";
import { job, document } from "../schema/index";
import { withTenant } from "../tenant";
import { adminDb } from "../admin-client";

/**
 * Webhook-side: resolve the job by its CompanyCam project id (globally-meaningful,
 * adminDb), then insert a `source='companycam'` document referencing the photo URL.
 * Idempotent: dedupes by (jobId, companycamPhotoId). Unknown project -> null.
 */
export async function recordCompanyCamPhoto(input: {
  projectId: string; photoId: string; url: string;
}): Promise<{ tenantId: string; jobId: string; documentId: string; created: boolean } | null> {
  const [j] = await adminDb
    .select({ id: job.id, tenantId: job.tenantId, customerId: job.customerId })
    .from(job)
    .where(eq(job.companycamProjectId, input.projectId));
  if (!j) return null;
  return withTenant(j.tenantId, async (tx) => {
    const [existing] = await tx
      .select({ id: document.id })
      .from(document)
      .where(and(eq(document.jobId, j.id), eq(document.companycamPhotoId, input.photoId)));
    if (existing) return { tenantId: j.tenantId, jobId: j.id, documentId: existing.id, created: false };
    const [row] = await tx.insert(document).values({
      tenantId: j.tenantId, jobId: j.id, customerId: j.customerId,
      kind: "photo", source: "companycam", externalUrl: input.url, companycamPhotoId: input.photoId,
    }).returning({ id: document.id });
    return { tenantId: j.tenantId, jobId: j.id, documentId: row!.id, created: true };
  });
}
