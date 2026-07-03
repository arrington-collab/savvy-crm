import { resolveTenantByIngestKey, resolvePhotoJob, recordSiteSnapPhoto } from "@savvy/db";
import type { StorageGateway } from "@savvy/integrations";

export type IngestBody = { address: string; category: string; imageUrl: string; externalPhotoId: string; capturedAt?: string };
export type IngestDeps = {
  storage: StorageGateway;
  fetchBytes: (url: string) => Promise<{ bytes: Uint8Array; mime: string }>;
  emit: (jobId: string | null, documentId: string, tenantId: string) => Promise<void>;
};

export async function ingestSiteSnapPhoto(body: IngestBody, key: string, deps: IngestDeps): Promise<{ status: number; body: unknown }> {
  const t = await resolveTenantByIngestKey(key);
  if (!t) return { status: 401, body: { error: "unauthorized" } };

  let img: { bytes: Uint8Array; mime: string };
  try { img = await deps.fetchBytes(body.imageUrl); }
  catch { return { status: 502, body: { error: "image_fetch_failed" } }; }

  const match = await resolvePhotoJob({ tenantId: t.tenantId, address: body.address });
  const r2Key = `sitesnap/${t.tenantId}/${body.externalPhotoId}`;
  await deps.storage.putObject({ key: r2Key, bytes: img.bytes, contentType: img.mime });

  const rec = await recordSiteSnapPhoto({
    tenantId: t.tenantId, jobId: match?.jobId ?? null, category: body.category,
    r2Key, captureAddress: body.address, sitesnapPhotoId: body.externalPhotoId,
  });

  if (rec.created) {
    // Fail-soft: the row is committed; an emit hiccup must not fail the webhook.
    try { await deps.emit(match?.jobId ?? null, rec.documentId, t.tenantId); } catch { /* noop */ }
  }
  return { status: 200, body: { ok: true, matched: match != null, documentId: rec.documentId } };
}
