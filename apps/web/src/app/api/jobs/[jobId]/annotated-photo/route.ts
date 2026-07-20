import type { NextRequest } from "next/server";
import { r2Storage } from "@savvy/integrations";
import { getTenantId } from "@/lib/tenant";
import { recordDocument } from "@/lib/document-actions";

export const runtime = "nodejs";

// Same-origin upload for a marked-up photo. The browser can't PUT straight to
// R2 (the bucket sends no CORS headers for cross-origin PUT), so the annotated
// PNG is POSTed here and written to R2 server-side — the same putObject the bulk
// importer uses, which needs no CORS and has no server-action body-size cap.
// Then recordDocument inserts the row (with its tenant/job key validation).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  const { jobId } = await params;
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof Blob)) return Response.json({ error: "no_file" }, { status: 400 });
  const filename = (form.get("filename") as string) || "markup.png";
  const label = (form.get("label") as string) || undefined;

  const tenantId = await getTenantId();
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  const key = `${tenantId}/${jobId}/${crypto.randomUUID()}-${safe}`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const contentType = file.type || "image/png";

  try {
    await r2Storage.putObject({ key, bytes, contentType });
  } catch {
    return Response.json({ error: "storage_not_configured" }, { status: 500 });
  }

  const rec = await recordDocument({
    jobId, r2Key: key, kind: "photo", label, filename, mime: contentType, sizeBytes: bytes.length,
  });
  if ("ok" in rec) return Response.json({ ok: true, id: rec.id });
  return Response.json({ error: rec.error }, { status: 400 });
}
