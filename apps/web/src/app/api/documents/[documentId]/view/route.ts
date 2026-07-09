import { getDocumentForView } from "@savvy/db";
import { r2Storage } from "@savvy/integrations";
import { getTenantId } from "@/lib/tenant";

export const runtime = "nodejs";

// Types safe to render inline on the app origin. Everything else (notably text/html and
// image/svg+xml, which can script) is forced to an attachment download with a neutral
// content-type — so a stored file can never execute in the app's origin.
const INLINE_SAFE = new Set(["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"]);

// Same-origin document viewer. The browser URL carries only the doc UUID — no R2 key, no
// filename, no PII. Tenant is resolved from the session; RLS blocks cross-tenant ids (→ 404).
// The R2 object is presigned + streamed server-side; the presigned URL never reaches the
// browser. `?download=1` swaps inline for an attachment disposition.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ documentId: string }> },
): Promise<Response> {
  const { documentId } = await params;
  const download = new URL(req.url).searchParams.get("download") === "1";

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

  const safe = (doc.filename ?? "document").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  const allowedInline = doc.mime != null && INLINE_SAFE.has(doc.mime);
  const asInline = allowedInline && !download;
  const headers = new Headers();
  // Only echo the stored mime for allowlisted types; anything else is served as a neutral
  // octet-stream so it cannot render (defense-in-depth beyond upload-time MIME validation).
  headers.set("Content-Type", allowedInline ? doc.mime! : "application/octet-stream");
  headers.set("Content-Disposition", `${asInline ? "inline" : "attachment"}; filename="${safe}"`);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cache-Control", "private, no-store");
  const len = upstream.headers.get("content-length");
  if (len) headers.set("Content-Length", len);
  return new Response(upstream.body, { status: 200, headers });
}
