import { eq } from "drizzle-orm";
import { adminDb } from "../admin-client";
import { withTenant } from "../tenant";
import { esignRequest } from "../schema/ops";

/**
 * Webhook-side status update. The webhook has no tenant session, so we resolve
 * the tenant via the globally-unique DocuSeal submission id (adminDb, bypassing
 * RLS for the read), then write the change inside withTenant (RLS-enforced).
 * Idempotent: a request already in a terminal state returns { changed: false }.
 */
export async function markEsignBySubmission(input: {
  submissionId: string;
  status: "completed" | "declined";
}): Promise<{ tenantId: string; requestId: string; changed: boolean } | null> {
  const [row] = await adminDb
    .select({ id: esignRequest.id, tenantId: esignRequest.tenantId, status: esignRequest.status })
    .from(esignRequest)
    .where(eq(esignRequest.docusealSubmissionId, input.submissionId));
  if (!row) return null;
  if (row.status === "completed" || row.status === "declined") {
    return { tenantId: row.tenantId, requestId: row.id, changed: false };
  }
  await withTenant(row.tenantId, (tx) =>
    tx
      .update(esignRequest)
      .set({
        status: input.status,
        completedAt: input.status === "completed" ? new Date() : null,
      })
      .where(eq(esignRequest.id, row.id)),
  );
  return { tenantId: row.tenantId, requestId: row.id, changed: true };
}
