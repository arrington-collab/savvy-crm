import { Jimp } from "jimp";
import { getDocumentForView } from "@savvy/db";
import { r2Storage } from "@savvy/integrations";
import { buildDocumentViewHeaders, clampThumbWidth } from "@savvy/core";
import { getTenantId } from "@/lib/tenant";

export const runtime = "nodejs";

// Same-origin document viewer. The browser URL carries only the doc UUID — no R2 key, no
// filename, no PII. Tenant is resolved from the session; RLS blocks cross-tenant ids (→ 404).
// The R2 object is presigned + streamed server-side; the presigned URL never reaches the
// browser. `?download=1` swaps inline for an attachment disposition.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ documentId: string }> },
): Promise<Response> {
  const { documentId } = await params;
  const sp = new URL(req.url).searchParams;
  const download = sp.get("download") === "1";
  const thumbWidth = clampThumbWidth(sp.get("w")); // ?w=192 → downscaled thumbnail

  const tenantId = await getTenantId();
  const doc = await getDocumentForView(tenantId, documentId);
  if (!doc || !doc.r2Key) return new Response("Not found", { status: 404 });

  let signed: string;
  try {
    ({ url: signed } = await r2Storage.presignDownload({ key: doc.r2Key }));
  } catch {
    return new Response("Storage not configured", { status: 404 });
  }

  const upstream = await fetch(signed);
  if (!upstream.ok || !upstream.body) return new Response("Not found", { status: 404 });

  const view = buildDocumentViewHeaders({ mime: doc.mime, filename: doc.filename, download });

  // Thumbnail/viewer path: downscale server-side so the grid + gallery transfer
  // ~KB, not the full-res original. Attempt whenever a width was requested — jimp
  // reads by content, NOT by doc.mime (which is often null on imported photos, the
  // bug that made this silently no-op). On ANY resize error (non-image, HEIC, …)
  // fall back to the original bytes — never break the image. Immutable
  // Cache-Control means each width variant is fetched+resized at most once/browser.
  if (thumbWidth && !download) {
    const original = Buffer.from(await upstream.arrayBuffer());
    try {
      const img = await Jimp.read(original);
      if (img.bitmap.width > thumbWidth) img.resize({ w: thumbWidth });
      const out = await img.getBuffer("image/jpeg");
      return new Response(new Uint8Array(out), {
        status: 200,
        headers: {
          "Content-Type": "image/jpeg",
          "Content-Disposition": 'inline; filename="thumbnail.jpg"',
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": view.cacheControl,
        },
      });
    } catch {
      return new Response(new Uint8Array(original), {
        status: 200,
        headers: { "Content-Type": view.contentType, "Content-Disposition": view.disposition, "X-Content-Type-Options": "nosniff", "Cache-Control": view.cacheControl },
      });
    }
  }

  const headers = new Headers();
  headers.set("Content-Type", view.contentType);
  headers.set("Content-Disposition", view.disposition);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cache-Control", view.cacheControl);
  const len = upstream.headers.get("content-length");
  if (len) headers.set("Content-Length", len);
  return new Response(upstream.body, { status: 200, headers });
}
