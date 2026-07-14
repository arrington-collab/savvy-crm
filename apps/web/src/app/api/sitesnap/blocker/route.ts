import { NextResponse } from "next/server";
import { inngest } from "@savvy/agents";
import { resolveTenantByIngestKey, resolvePhotoJob, reportProductionBlocker } from "@savvy/db";

export const runtime = "nodejs";

type BlockerBody = {
  address: string;
  kind: string; // material_short|weather|homeowner_issue|hidden_damage|other
  note?: string;
  phaseKey?: string;
  photoIds?: string[];
  crewMemberName?: string;
};

/**
 * Crew flags a blocker from BloomCam — an IMMEDIATE office card (the only way
 * routine field reality reaches a human). hidden_damage fires the change-order
 * stub draft with the photos attached. Same ingest-key auth as the photo pipe.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const key = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const t = await resolveTenantByIngestKey(key);
  if (!t) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: BlockerBody;
  try { body = (await req.json()) as BlockerBody; } catch { return NextResponse.json({ error: "bad_payload" }, { status: 400 }); }
  if (!body?.address || !body?.kind) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const match = await resolvePhotoJob({ tenantId: t.tenantId, address: body.address });
  if (!match) return NextResponse.json({ error: "no_job_match" }, { status: 404 });

  const res = await reportProductionBlocker({
    tenantId: t.tenantId, jobId: match.jobId, kind: body.kind, phaseKey: body.phaseKey ?? null,
    note: body.note ?? null, photoIds: body.photoIds ?? [], reportedByName: body.crewMemberName ?? null,
  });
  if ("error" in res) return NextResponse.json({ error: res.error }, { status: 404 });

  try {
    await inngest.send({ name: "production/blocker.reported", data: { tenantId: t.tenantId, jobId: match.jobId, blockerId: res.blockerId, kind: body.kind } });
  } catch { /* fail-soft: the card exists; the stub draft is a bonus */ }
  return NextResponse.json({ ok: true, blockerId: res.blockerId });
}
