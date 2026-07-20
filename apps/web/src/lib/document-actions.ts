"use server";
import { withTenant, job, lead, document, eq, keepFlaggedPhoto as dbKeepFlaggedPhoto, recordLeadDocument } from "@savvy/db";
import { r2Storage } from "@savvy/integrations";
import { validateUpload, PARSEABLE_KINDS, type UploadValidationError } from "@savvy/core";
import { inngest } from "@savvy/agents";
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
  // Parseable uploads (insurance estimate, measurement report) attached to a job
  // feed the parse pipeline — extract the carrier claim / roof measurement.
  if ((PARSEABLE_KINDS as readonly string[]).includes(input.kind)) {
    await inngest.send({
      name: "lead-document/received",
      data: { tenantId, documentId: res.id, jobId: input.jobId, kind: input.kind, scopeId: input.jobId },
    }).catch(() => {});
  }
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

export async function presignLeadDocumentUpload(input: {
  leadId: string;
  kind: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}): Promise<
  { ok: true; uploadUrl: string; r2Key: string }
  | { error: "not_found" | "storage_not_configured" | UploadValidationError }
> {
  const tenantId = await getTenantId();
  const v = validateUpload({ kind: input.kind, mime: input.contentType, sizeBytes: input.sizeBytes });
  if (!v.ok) return { error: v.error };
  const found = await withTenant(tenantId, async (tx) => {
    const [l] = await tx.select({ id: lead.id }).from(lead).where(eq(lead.id, input.leadId));
    return l;
  });
  if (!found) return { error: "not_found" };
  const safe = input.filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  const r2Key = `${tenantId}/lead/${input.leadId}/${crypto.randomUUID()}-${safe}`;
  try {
    const { url } = await r2Storage.presignUpload({ key: r2Key, contentType: input.contentType });
    return { ok: true, uploadUrl: url, r2Key };
  } catch {
    return { error: "storage_not_configured" };
  }
}

export async function recordLeadDocumentAction(input: {
  leadId: string;
  r2Key: string;
  kind: string;
  filename: string;
  mime: string;
  sizeBytes: number;
}): Promise<{ ok: true; id: string } | { error: "bad_key" | "not_found" | UploadValidationError }> {
  const { tenantId, userId } = await getCurrentUser();
  const v = validateUpload({ kind: input.kind, mime: input.mime, sizeBytes: input.sizeBytes });
  if (!v.ok) return { error: v.error };
  // Reject any r2Key not scoped to this tenant+lead — defense against forged keys.
  if (!input.r2Key.startsWith(`${tenantId}/lead/${input.leadId}/`)) return { error: "bad_key" };
  // TEST_MODE's getCurrentUser returns the non-UUID sentinel "test-user"; uploaded_by_user_id
  // FK is nullable, so record null rather than a fake id.
  const auditUserId = userId === "test-user" ? null : userId;
  const res = await recordLeadDocument({
    tenantId,
    leadId: input.leadId,
    r2Key: input.r2Key,
    kind: input.kind,
    filename: input.filename,
    mime: input.mime,
    sizeBytes: input.sizeBytes,
    uploadedByUserId: auditUserId,
  });
  if (!res) return { error: "not_found" };
  // Parseable uploads feed the parse pipeline (6b measurement, 6c insurance).
  if ((PARSEABLE_KINDS as readonly string[]).includes(input.kind)) {
    await inngest.send({
      name: "lead-document/received",
      data: { tenantId, documentId: res.id, leadId: input.leadId, kind: input.kind, scopeId: input.leadId },
    }).catch(() => {});
  }
  revalidatePath(`/leads/${input.leadId}`);
  return { ok: true, id: res.id };
}

/**
 * Re-run the parse pipeline for one parseable document. Sets the doc back to `pending`
 * (instant "Parsing…" feedback), then re-emits `lead-document/received`. Idempotent: the
 * fail-soft handler coalesce-guards confirmed claim fields and upserts the measurement, so
 * a re-parse never clobbers human-confirmed data and never litters measurement rows.
 */
export async function reparseDocument(
  documentId: string,
): Promise<{ ok: true } | { error: "not_found" | "not_parseable" }> {
  const { tenantId } = await getCurrentUser();
  const doc = await withTenant(tenantId, async (tx) => {
    const [d] = await tx
      .select({ id: document.id, kind: document.kind, leadId: document.leadId, jobId: document.jobId })
      .from(document)
      .where(eq(document.id, documentId));
    return d;
  });
  // Works for lead- OR job-attached docs (a bulk-imported carrier estimate hangs
  // off a job with no lead). scopeId serializes the parse per subject.
  if (!doc || (!doc.leadId && !doc.jobId)) return { error: "not_found" };
  if (!(PARSEABLE_KINDS as readonly string[]).includes(doc.kind)) return { error: "not_parseable" };
  const scopeId = doc.leadId ?? doc.jobId!;

  await withTenant(tenantId, (tx) =>
    tx.update(document).set({ parseStatus: "pending", parseConfidence: null }).where(eq(document.id, documentId)),
  );
  await inngest.send({
    name: "lead-document/received",
    data: { tenantId, documentId, leadId: doc.leadId, jobId: doc.jobId, kind: doc.kind, scopeId },
  }).catch(() => {});
  revalidatePath(doc.leadId ? `/leads/${doc.leadId}` : `/jobs/${doc.jobId}`);
  return { ok: true };
}
