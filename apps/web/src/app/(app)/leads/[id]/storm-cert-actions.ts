"use server";
import { withTenant, document, eq } from "@savvy/db";
import { r2Storage } from "@savvy/integrations";
import { getTenantId } from "@/lib/tenant";

/**
 * Returns a short-lived signed download URL for a storm cert document.
 * Returns null if the document is missing, has no R2 key, or storage is
 * not configured — callers should treat null as "not available".
 */
export async function getStormCertDownloadUrl(documentId: string): Promise<string | null> {
  const tenantId = await getTenantId();
  const doc = await withTenant(tenantId, async (tx) => {
    const [d] = await tx
      .select({ r2Key: document.r2Key })
      .from(document)
      .where(eq(document.id, documentId));
    return d;
  });
  if (!doc?.r2Key) return null;
  try {
    const { url } = await r2Storage.presignDownload({ key: doc.r2Key });
    return url;
  } catch {
    return null;
  }
}
