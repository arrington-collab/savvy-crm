import { resolveEstimateLink, videosForEstimate, withTenant, document, eq, parseOwnerVideoConfigRow } from "@savvy/db";
import { r2Storage } from "@savvy/integrations";

export const runtime = "nodejs";

// Public, token-gated video proxy: only THIS estimate's takes (or the tenant's
// generic video) stream; presigned URLs never reach the browser.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ code: string; documentId: string }> },
): Promise<Response> {
  const { code, documentId } = await params;
  const link = await resolveEstimateLink(code);
  if (!link) return new Response("Not found", { status: 404 });

  const vids = await videosForEstimate(link.tenantId, link.estimateId);
  let allowed = vids.some((v) => v.documentId === documentId);
  if (!allowed) {
    const generic = await parseOwnerVideoConfigRow(link.tenantId);
    allowed = generic.genericDocumentId === documentId;
  }
  if (!allowed) return new Response("Not found", { status: 404 });

  const [doc] = await withTenant(link.tenantId, (tx) =>
    tx.select({ r2Key: document.r2Key, mime: document.mime }).from(document).where(eq(document.id, documentId)),
  );
  if (!doc?.r2Key) return new Response("Not found", { status: 404 });

  let signed: string;
  try {
    ({ url: signed } = await r2Storage.presignDownload({ key: doc.r2Key }));
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const upstream = await fetch(signed);
  if (!upstream.ok || !upstream.body) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  headers.set("Content-Type", doc.mime ?? "video/webm");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cache-Control", "private, max-age=300");
  return new Response(upstream.body, { status: 200, headers });
}
