import { resolveEstimateLink, recordEstimateEvent, listEstimateEvents, ESTIMATE_EVENT_KINDS, type EstimateEventKind } from "@savvy/db";
import { isHotSignal, raceAllowed } from "@savvy/core";
import { inngest } from "@savvy/agents";
import { log } from "@/lib/log";

export const runtime = "nodejs";

const CLIENT_KINDS: EstimateEventKind[] = ["open", "dwell", "tier_view", "color_play", "video_watch"];

// Public, token-gated, first-party telemetry beacon. An `open` that qualifies
// as a hot signal (first open / return visit) starts the 60-second rep race.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ code: string }> },
): Promise<Response> {
  const { code } = await params;
  const link = await resolveEstimateLink(code);
  if (!link) return new Response("Not found", { status: 404 });

  let body: { kind?: string; sessionId?: string; meta?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false }, { status: 400 });
  }
  const kind = body.kind as EstimateEventKind;
  if (!CLIENT_KINDS.includes(kind) || !ESTIMATE_EVENT_KINDS.includes(kind)) {
    return Response.json({ ok: false, error: "bad_kind" }, { status: 400 });
  }
  const sessionId = (body.sessionId ?? "").slice(0, 64) || null;

  // Race trigger decided BEFORE recording this open (the event lists must
  // reflect the state the signal arrived into).
  let startRace = false;
  if (kind === "open" && sessionId) {
    const events = await listEstimateEvents(link.tenantId, link.estimateId);
    startRace = isHotSignal(events, sessionId) && raceAllowed(events, sessionId);
  }

  await recordEstimateEvent({
    tenantId: link.tenantId,
    estimateId: link.estimateId,
    kind,
    sessionId,
    meta: typeof body.meta === "object" && body.meta ? body.meta : {},
  });

  if (startRace && sessionId) {
    try {
      await inngest.send({
        name: "estimate/page.opened",
        data: { tenantId: link.tenantId, estimateId: link.estimateId, sessionId },
      });
    } catch (e) {
      log.error("estimate/page.opened emit failed", { route: "/api/estimate/telemetry", tenantId: link.tenantId, msg: String(e) });
    }
  }
  return Response.json({ ok: true });
}
