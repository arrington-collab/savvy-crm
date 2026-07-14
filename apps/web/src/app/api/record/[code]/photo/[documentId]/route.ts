import { resolveRecordLink, getRecordPageData, getRecordComparison } from "@savvy/db";
import { r2Storage } from "@savvy/integrations";

export const runtime = "nodejs";

// Public, token-gated photo proxy for the Roof Record: only QC-passed photos
// belonging to THIS published Record's zones stream; the R2 presign never
// reaches the browser. The record token is permanent; the media URLs it
// resolves are short-lived (same pattern as the estimate page).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ code: string; documentId: string }> },
): Promise<Response> {
  const { code, documentId } = await params;
  const link = await resolveRecordLink(code);
  if (!link) return new Response("Not found", { status: 404 });

  const data = await getRecordPageData({ tenantId: link.tenantId, inspectionId: link.inspectionId });
  let photo = data?.zones.flatMap((z) => z.photos).find((p) => p.documentId === documentId);
  if (!photo?.r2Key) {
    // Baseline photos in the before/after view belong to the BASELINE
    // inspection — allow exactly the comparison's photo set, nothing wider.
    const cmp = await getRecordComparison({ tenantId: link.tenantId, inspectionId: link.inspectionId });
    photo = cmp?.zones.flatMap((z) => [...z.beforePhotos, ...z.afterPhotos]).find((p) => p.documentId === documentId);
  }
  if (!photo?.r2Key) return new Response("Not found", { status: 404 });

  let signed: string;
  try {
    ({ url: signed } = await r2Storage.presignDownload({ key: photo.r2Key }));
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const upstream = await fetch(signed);
  if (!upstream.ok || !upstream.body) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  headers.set("Content-Type", "image/jpeg");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cache-Control", "private, max-age=300");
  return new Response(upstream.body, { status: 200, headers });
}
