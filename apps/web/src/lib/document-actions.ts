"use server";
import { withTenant, job, document, eq, keepFlaggedPhoto as dbKeepFlaggedPhoto } from "@savvy/db";
import { r2Storage } from "@savvy/integrations";
import { revalidatePath } from "next/cache";
import { getTenantId } from "./tenant";
import { getCurrentUser } from "./current-user";

export async function presignDocumentUpload(input: {
  jobId: string;
  kind: string;
  label?: string;
  filename: string;
  contentType: string;
}): Promise<{ ok: true; uploadUrl: string; r2Key: string } | { error: "not_found" | "storage_not_configured" }> {
  const tenantId = await getTenantId();
  const found = await withTenant(tenantId, async (tx) => {
    const [j] = await tx.select({ id: job.id }).from(job).where(eq(job.id, input.jobId));
    return j;
  });
  if (!found) return { error: "not_found" };
  // Sanitize filename and scope the R2 key under tenant/job to prevent key collisions
  const safe = input.filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  const r2Key = `${tenantId}/${input.jobId}/${crypto.randomUUID()}-${safe}`;
  try {
    const { url } = await r2Storage.presignUpload({ key: r2Key, contentType: input.contentType });
    return { ok: true, uploadUrl: url, r2Key };
  } catch {
    return { error: "storage_not_configured" };
  }
}

export async function recordDocument(input: {
  jobId: string;
  r2Key: string;
  kind: string;
  label?: string;
  filename: string;
  mime: string;
  sizeBytes: number;
}): Promise<{ ok: true; id: string } | { error: "bad_key" | "not_found" }> {
  const tenantId = await getTenantId();
  // Reject any r2Key not scoped to this tenant+job — defense against forged keys
  if (!input.r2Key.startsWith(`${tenantId}/${input.jobId}/`)) return { error: "bad_key" };
  const res = await withTenant(tenantId, async (tx) => {
    const [j] = await tx
      .select({ id: job.id, customerId: job.customerId })
      .from(job)
      .where(eq(job.id, input.jobId));
    if (!j) return null;
    const [row] = await tx
      .insert(document)
      .values({
        tenantId,
        jobId: input.jobId,
        customerId: j.customerId ?? null,
        kind: input.kind,
        label: input.label ?? null,
        r2Key: input.r2Key,
        filename: input.filename,
        mime: input.mime,
        sizeBytes: input.sizeBytes,
        source: "savvy",
      })
      .returning({ id: document.id });
    return row;
  });
  if (!res) return { error: "not_found" };
  revalidatePath(`/jobs/${input.jobId}`);
  return { ok: true, id: res.id };
}

export async function presignDocumentView(
  documentId: string,
): Promise<{ ok: true; url: string } | { error: "not_found" | "storage_not_configured" }> {
  const tenantId = await getTenantId();
  const doc = await withTenant(tenantId, async (tx) => {
    const [d] = await tx
      .select({ r2Key: document.r2Key })
      .from(document)
      .where(eq(document.id, documentId));
    return d;
  });
  if (!doc) return { error: "not_found" };
  // CompanyCam-sourced documents have no R2 object (they reference externalUrl);
  // presigned R2 views don't apply to them.
  if (!doc.r2Key) return { error: "not_found" };
  try {
    const { url } = await r2Storage.presignDownload({ key: doc.r2Key });
    return { ok: true, url };
  } catch {
    return { error: "storage_not_configured" };
  }
}

/**
 * Accept a flagged photo ("Keep"). Flips qc_status flagged→passed + writes an audit row
 * (via the db layer), then revalidates the job page and the exceptions queue so the
 * photo_quality exception clears. Idempotent — a non-flagged/foreign doc returns not_found.
 */
export async function keepFlaggedPhoto(
  documentId: string,
): Promise<{ ok: true } | { error: "not_found" }> {
  const { tenantId, userId } = await getCurrentUser();
  // TEST_MODE's getCurrentUser returns the non-UUID sentinel "test-user"; the audit
  // user_id FK is nullable, so record null rather than a fake id.
  const auditUserId = userId === "test-user" ? null : userId;
  const res = await dbKeepFlaggedPhoto({ tenantId, userId: auditUserId, documentId });
  if (!res) return { error: "not_found" };
  revalidatePath(`/jobs/${res.jobId}`);
  revalidatePath("/exceptions");
  return { ok: true };
}
