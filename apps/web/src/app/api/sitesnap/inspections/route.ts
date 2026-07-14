import { NextResponse } from "next/server";
import { inngest } from "@savvy/agents";
import { resolveTenantByIngestKey, startInspectionByAddress, completeInspection, getInspectionScope } from "@savvy/db";
import { log } from "@/lib/log";

export const runtime = "nodejs";

type InspectionEventBody =
  | { action: "start"; address: string }
  | { action: "complete"; inspectionId: string };

/**
 * BloomCam capture lifecycle (same ingest-key auth as the photo pipe).
 * start:    address → newest open lead → in_progress inspection (idempotent —
 *           a retried start resumes, never forks). Returns the inspectionId
 *           BloomCam stamps on every media event.
 * complete: in_progress → pending_approval, then inspection/completed fires the
 *           final estimate re-price. Idempotent: a replayed complete is ok:true.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const key = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const t = await resolveTenantByIngestKey(key);
  if (!t) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: InspectionEventBody;
  try { body = (await req.json()) as InspectionEventBody; } catch { return NextResponse.json({ error: "bad_payload" }, { status: 400 }); }

  if (body.action === "start") {
    if (!body.address) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    const res = await startInspectionByAddress({ tenantId: t.tenantId, address: body.address });
    if ("error" in res) return NextResponse.json({ error: res.error }, { status: 404 });
    return NextResponse.json({ ok: true, inspectionId: res.inspectionId, resumed: !res.created });
  }

  if (body.action === "complete") {
    if (!body.inspectionId) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    const res = await completeInspection({ tenantId: t.tenantId, inspectionId: body.inspectionId });
    if ("error" in res) {
      // A replayed complete is success from BloomCam's side; anything else 409s.
      const scope = await getInspectionScope({ tenantId: t.tenantId, inspectionId: body.inspectionId });
      if (scope && scope.status !== "in_progress") return NextResponse.json({ ok: true, replay: true });
      return NextResponse.json({ error: res.error }, { status: 409 });
    }
    try {
      const scope = await getInspectionScope({ tenantId: t.tenantId, inspectionId: body.inspectionId });
      await inngest.send({ name: "inspection/completed", data: { tenantId: t.tenantId, inspectionId: body.inspectionId, leadId: scope?.leadId ?? null } });
    } catch {
      // Fail-soft: completion is committed; the finalize event is a re-price
      // optimization, not correctness (the draft already refreshed per photo).
      log.error("inspection complete emit failed", { route: "/api/sitesnap/inspections" });
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "unknown_action" }, { status: 400 });
}
