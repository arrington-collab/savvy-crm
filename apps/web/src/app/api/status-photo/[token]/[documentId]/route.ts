import { verifyPayloadToken } from "@savvy/core";
import { statusGalleryForJob } from "@savvy/db";
import { r2Storage } from "@savvy/integrations";

export const runtime = "nodejs";

// Token-gated photo proxy for the status-page gallery: only DOUBLE-GATED
// photos (QC-passed AND customer-safe) of THIS job stream; presigns never
// reach the browser (same pattern as the estimate/record proxies).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string; documentId: string }> },
): Promise<Response> {
  const { token, documentId } = await params;
  const payload = verifyPayloadToken<{ tenantId: string; jobId: string }>(
    token, process.env.UNSUBSCRIBE_SECRET ?? "dev-unsubscribe-secret",
  );
  if (!payload?.tenantId || !payload?.jobId) return new Response("Not found", { status: 404 });

  const gallery = await statusGalleryForJob({ tenantId: payload.tenantId, jobId: payload.jobId });
  const photo = gallery.flatMap((d) => d.photos).find((p) => p.documentId === documentId);
  if (!photo?.r2Key) return new Response("Not found", { status: 404 });

  let signed: string;
  try { ({ url: signed } = await r2Storage.presignDownload({ key: photo.r2Key })); }
  catch { return new Response("Not found", { status: 404 }); }
  const upstream = await fetch(signed);
  if (!upstream.ok || !upstream.body) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  headers.set("Content-Type", "image/jpeg");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cache-Control", "private, max-age=300");
  return new Response(upstream.body, { status: 200, headers });
}
