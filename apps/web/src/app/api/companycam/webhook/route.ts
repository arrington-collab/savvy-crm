import { NextResponse } from "next/server";
import { recordCompanyCamPhoto, recordAgentRun } from "@savvy/db";
import { companyCam } from "@savvy/integrations";
import { log } from "@/lib/log";

export const runtime = "nodejs"; // node:crypto for HMAC

// CompanyCam posts photo events here. Verify HMAC, parse, resolve the job by its
// companycamProjectId (adminDb, inside recordCompanyCamPhoto), insert a
// reference-by-URL document, and log a scheduling/photo.companycam run (-> SCOUT).
export async function POST(req: Request): Promise<NextResponse> {
  const raw = await req.text();
  const sig = req.headers.get("x-companycam-signature");
  if (!companyCam.verifyWebhook(raw, sig)) return new NextResponse("bad signature", { status: 401 });

  let payload: unknown = null;
  try { payload = JSON.parse(raw); } catch { return new NextResponse("bad payload", { status: 400 }); }

  const ev = companyCam.parseEvent(payload);
  if (!ev) return NextResponse.json({ ok: true }); // non-photo / unparseable -> no-op
  log.info("companycam webhook received", { route: "/api/companycam/webhook" });

  const res = await recordCompanyCamPhoto({ projectId: ev.projectId, photoId: ev.photoId, url: ev.url });
  if (res?.created) {
    await recordAgentRun({ tenantId: res.tenantId, agent: "scheduling", taskKey: "photo.companycam", jobId: res.jobId, status: "ok" });
  }
  return NextResponse.json({ ok: true });
}
