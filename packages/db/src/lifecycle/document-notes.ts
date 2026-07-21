import { and, eq } from "drizzle-orm";
import { withTenant } from "../tenant";
import { document } from "../schema/ops";

/** Set (or clear) a document's free-form note. Trims; empty → null. Tenant-scoped
 *  under RLS; returns false when the document isn't in the tenant. The rep writes
 *  these on job photos in the gallery; job-scoped notes feed AI upsell drafting
 *  (see listJobPhotoNotes). */
export async function setDocumentNote(
  tenantId: string,
  input: { documentId: string; notes: string },
): Promise<boolean> {
  const trimmed = input.notes.trim();
  return withTenant(tenantId, async (tx) => {
    const [cur] = await tx.select({ id: document.id }).from(document).where(eq(document.id, input.documentId));
    if (!cur) return false;
    await tx.update(document).set({ notes: trimmed === "" ? null : trimmed }).where(eq(document.id, input.documentId));
    return true;
  });
}

/** The rep-authored notes on a job's PHOTO documents (non-empty, trimmed). Fed to
 *  AI upsell drafting so suggestions reflect what the rep saw in the field. */
export async function listJobPhotoNotes(tenantId: string, jobId: string): Promise<string[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({ notes: document.notes })
      .from(document)
      .where(and(eq(document.jobId, jobId), eq(document.kind, "photo")));
    return rows.map((r) => (r.notes ?? "").trim()).filter((n) => n.length > 0);
  });
}
