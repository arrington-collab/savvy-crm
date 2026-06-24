"use server";
import { withTenant, lead, document, eq } from "@savvy/db";
import { r2Storage } from "@savvy/integrations";
import { getTenantId } from "@/lib/tenant";

/**
 * Returns a short-lived signed download URL for the storm cert attached to
 * the given lead. Resolves the document via the lead's own stormCertDocumentId
 * (not a caller-supplied document id) and requires kind === "cert" — this
 * prevents IDOR attacks where a caller could pass an arbitrary document id
 * to retrieve signed URLs for other leads' documents or non-cert files.
 */
export async function getStormCertDownloadUrl(leadId: string): Promise<string | null> {
  const tenantId = await getTenantId();
  return withTenant(tenantId, async (tx) => {
    const [l] = await tx
      .select({ docId: lead.stormCertDocumentId })
      .from(lead)
      .where(eq(lead.id, leadId));
    if (!l?.docId) return null;
    const [d] = await tx
      .select({ r2Key: document.r2Key, kind: document.kind })
      .from(document)
      .where(eq(document.id, l.docId));
    if (!d?.r2Key || d.kind !== "cert") return null;
    try {
      const { url } = await r2Storage.presignDownload({ key: d.r2Key });
      return url;
    } catch {
      return null;
    }
  });
}
