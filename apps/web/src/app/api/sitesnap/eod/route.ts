import { NextResponse } from "next/server";
import { inngest } from "@savvy/agents";
import { resolveTenantByIngestKey, resolvePhotoJob, submitCrewEodReport } from "@savvy/db";

export const runtime = "nodejs";

type EodBody = {
  address: string;
  whatGotDone: string;
  blockers?: unknown[];
  tomorrowPlan?: string;
  crewMemberName?: string;
  source?: "form" | "voice";
};

/**
 * BloomCam end-of-day report (60-second voice memo or 3-tap form): REQUIRED to
 * close the crew day. Upserts per job-day (the crew corrects, never duplicates)
 * and fires the homeowner evening wrap. Same ingest-key auth as the photo pipe.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const key = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const t = await resolveTenantByIngestKey(key);
  if (!t) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: EodBody;
  try { body = (await req.json()) as EodBody; } catch { return NextResponse.json({ error: "bad_payload" }, { status: 400 }); }
  if (!body?.address || !body?.whatGotDone) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const match = await resolvePhotoJob({ tenantId: t.tenantId, address: body.address });
  if (!match) return NextResponse.json({ error: "no_job_match" }, { status: 404 });

  const res = await submitCrewEodReport({
    tenantId: t.tenantId, jobId: match.jobId, whatGotDone: body.whatGotDone,
    blockers: body.blockers ?? [], tomorrowPlan: body.tomorrowPlan ?? null,
    source: body.source ?? "form", reportedByName: body.crewMemberName ?? null,
  });
  // Fail-soft: the report is committed; the wrap event is a delivery concern.
  try {
    await inngest.send({ name: "production/eod.reported", data: { tenantId: t.tenantId, jobId: match.jobId, dayKey: res.dayKey } });
  } catch { /* noop */ }
  return NextResponse.json({ ok: true, dayKey: res.dayKey, updated: !res.created });
}
