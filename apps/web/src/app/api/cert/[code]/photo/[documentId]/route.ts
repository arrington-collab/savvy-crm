import { resolveCertLink, getCertPageData } from "@savvy/db";
import { r2Storage } from "@savvy/integrations";

export const runtime = "nodejs";

// Public, token-gated photo proxy for the cert page: only QC-passed photos
// belonging to THIS delivered cert's inspection zones stream; the R2 presign
// never reaches the browser (same pattern as the Roof Record proxy).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ code: string; documentId: string }> },
): Promise<Response> {
  const { code, documentId } = await params;
  const link = await resolveCertLink(code);
  if (!link) return new Response("Not found", { status: 404 });

  const data = await getCertPageData(link.tenantId, link.certRequestId);
  const photo = data?.zones.flatMap((z) => z.photos).find((p) => p.documentId === documentId);
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
