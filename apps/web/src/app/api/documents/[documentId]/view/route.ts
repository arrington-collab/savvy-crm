import { getDocumentForView } from "@savvy/db";
import { r2Storage } from "@savvy/integrations";
import { buildDocumentViewHeaders, clampThumbWidth, photoVariantKey, PHOTO_VARIANT_WIDTHS } from "@savvy/core";
import { getTenantId } from "@/lib/tenant";

export const runtime = "nodejs";

// Same-origin document viewer. The browser URL carries only the doc UUID — no R2 key, no
// filename, no PII. Tenant is resolved from the session; RLS blocks cross-tenant ids (→ 404).
// The R2 object is presigned + streamed server-side; the presigned URL never reaches the
// browser. `?download=1` swaps inline for an attachment disposition.
//
// `?w=<192|1600>` streams a PRE-GENERATED width variant (see the pregenerate-thumbnails
// backfill + PHOTO_VARIANT_WIDTHS). The variants are built offline with sharp, so the
// request path does NO resize — instant, and no native image lib in the function. If a
// photo has no variants yet (thumbsReady=false) or an unexpected width is asked for, we
// stream the original untouched (correct, just larger) rather than resize on the fly.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ documentId: string }> },
): Promise<Response> {
  const { documentId } = await params;
  const sp = new URL(req.url).searchParams;
  const download = sp.get("download") === "1";
  const thumbWidth = clampThumbWidth(sp.get("w"));

  const tenantId = await getTenantId();
  const doc = await getDocumentForView(tenantId, documentId);
  if (!doc || !doc.r2Key) return new Response("Not found", { status: 404 });

  // Serve a pre-generated variant when one exists for the requested width.
  const usePregen =
    !download &&
    doc.thumbsReady &&
    thumbWidth != null &&
    (PHOTO_VARIANT_WIDTHS as readonly number[]).includes(thumbWidth);
  const key = usePregen ? photoVariantKey(doc.r2Key, thumbWidth!) : doc.r2Key;

  let signed: string;
  try {
    ({ url: signed } = await r2Storage.presignDownload({ key }));
  } catch {
    return new Response("Storage not configured", { status: 404 });
  }

  let upstream = await fetch(signed);
  // A missing variant (e.g. a partial backfill) must never 404 the image — fall back to
  // the original.
  if ((!upstream.ok || !upstream.body) && usePregen) {
    try {
      ({ url: signed } = await r2Storage.presignDownload({ key: doc.r2Key }));
      upstream = await fetch(signed);
    } catch { /* fall through to the not-found below */ }
  }
  if (!upstream.ok || !upstream.body) return new Response("Not found", { status: 404 });

  const view = buildDocumentViewHeaders({ mime: doc.mime, filename: doc.filename, download });
  const headers = new Headers();
  // A served variant is always a JPEG; otherwise honour the document's own type.
  headers.set("Content-Type", usePregen ? "image/jpeg" : view.contentType);
  headers.set("Content-Disposition", usePregen ? 'inline; filename="photo.jpg"' : view.disposition);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cache-Control", view.cacheControl);
  const len = upstream.headers.get("content-length");
  if (len) headers.set("Content-Length", len);
  return new Response(upstream.body, { status: 200, headers });
}
