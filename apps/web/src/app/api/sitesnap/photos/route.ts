import { NextResponse } from "next/server";
import { inngest } from "@savvy/agents";
import { r2Storage } from "@savvy/integrations";
import { ingestSiteSnapPhoto, type IngestBody } from "@/lib/sitesnap-ingest";
import { log } from "@/lib/log";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<NextResponse> {
  const key = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  let body: IngestBody;
  try { body = (await req.json()) as IngestBody; } catch { return NextResponse.json({ error: "bad_payload" }, { status: 400 }); }
  if (!body?.address || !body?.category || !body?.imageUrl || !body?.externalPhotoId) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const res = await ingestSiteSnapPhoto(body, key, {
    storage: r2Storage,
    fetchBytes: async (url) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`fetch ${r.status}`);
      const buf = new Uint8Array(await r.arrayBuffer());
      return { bytes: buf, mime: r.headers.get("content-type") ?? "image/jpeg" };
    },
    emit: async (jobId, documentId, tenantId) => {
      await inngest.send({ name: "photo/ingested", data: { tenantId, documentId, jobId } });
    },
  });
  if (res.status >= 500) log.error("sitesnap ingest failed", { route: "/api/sitesnap/photos", status: res.status });
  return NextResponse.json(res.body, { status: res.status });
}
