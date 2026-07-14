// Estimate Experience slice 4: first-party page telemetry. Events are stored
// on the estimate (evidence + NOVA's race trigger) — never a third party.

import { and, eq, inArray, gte, isNotNull } from "drizzle-orm";
import { withTenant } from "../tenant";
import { estimateEvent } from "../schema/finance";
import { estimate } from "../schema/finance";

export const ESTIMATE_EVENT_KINDS = [
  "open",
  "dwell",
  "tier_view",
  "color_play",
  "race_rep_notified",
  "race_rep_ack",
  "race_nova_text",
  "race_skipped",
  "expiry_notice",
  "question",
  "question_escalated",
  "video_sent",
  "video_watch",
  "followup_sent",
] as const;
export type EstimateEventKind = (typeof ESTIMATE_EVENT_KINDS)[number];

export async function recordEstimateEvent(input: {
  tenantId: string;
  estimateId: string;
  kind: EstimateEventKind;
  sessionId?: string | null;
  meta?: Record<string, unknown>;
}): Promise<void> {
  await withTenant(input.tenantId, (tx) =>
    tx.insert(estimateEvent).values({
      tenantId: input.tenantId,
      estimateId: input.estimateId,
      kind: input.kind,
      sessionId: input.sessionId ?? null,
      meta: input.meta ?? {},
    }),
  );
}

export async function listEstimateEvents(
  tenantId: string,
  estimateId: string,
): Promise<{ kind: string; sessionId: string | null; createdAt: Date; meta: Record<string, unknown> }[]> {
  return withTenant(tenantId, (tx) =>
    tx
      .select({ kind: estimateEvent.kind, sessionId: estimateEvent.sessionId, createdAt: estimateEvent.createdAt, meta: estimateEvent.meta })
      .from(estimateEvent)
      .where(eq(estimateEvent.estimateId, estimateId)),
  );
}

/** Race outcomes joined with acceptance for the metrics card (last 90 days of
 *  race activity, grouped per estimate). */
export async function raceOutcomeRows(
  tenantId: string,
): Promise<{ events: { kind: string; sessionId: string | null; createdAt: Date }[]; accepted: boolean }[]> {
  return withTenant(tenantId, async (tx) => {
    const raceKinds = ["race_rep_notified", "race_rep_ack", "race_nova_text"];
    const rows = await tx
      .select({ estimateId: estimateEvent.estimateId, kind: estimateEvent.kind, sessionId: estimateEvent.sessionId, createdAt: estimateEvent.createdAt })
      .from(estimateEvent)
      .where(inArray(estimateEvent.kind, raceKinds));
    if (rows.length === 0) return [];
    const ids = [...new Set(rows.map((r) => r.estimateId))];
    const ests = await tx
      .select({ id: estimate.id, status: estimate.status })
      .from(estimate)
      .where(and(inArray(estimate.id, ids)));
    const acceptedById = new Map(ests.map((e) => [e.id, e.status === "accepted"]));
    return ids.map((id) => ({
      events: rows.filter((r) => r.estimateId === id),
      accepted: acceptedById.get(id) ?? false,
    }));
  });
}

/** Slice 7: the close-rate loop's raw rows — every sent estimate (90 days)
 *  with its template version, tier, open/accept outcomes, and the video
 *  personalized-vs-generic marker. */
export async function closeRateRows(
  tenantId: string,
  now = new Date(),
): Promise<{ templateVersion: string; tier: string | null; opened: boolean; accepted: boolean; videoPersonalized: boolean | null }[]> {
  return withTenant(tenantId, async (tx) => {
    const since = new Date(now.getTime() - 90 * 86_400_000);
    const sent = await tx
      .select()
      .from(estimate)
      .where(and(gte(estimate.sentAt, since), isNotNull(estimate.sentAt)));
    if (sent.length === 0) return [];
    const events = await tx
      .select({ estimateId: estimateEvent.estimateId, kind: estimateEvent.kind, meta: estimateEvent.meta })
      .from(estimateEvent)
      .where(inArray(estimateEvent.estimateId, sent.map((e) => e.id)));
    const byEstimate = new Map<string, { kind: string; meta: Record<string, unknown> }[]>();
    for (const ev of events) {
      byEstimate.set(ev.estimateId, [...(byEstimate.get(ev.estimateId) ?? []), ev]);
    }
    return sent.map((e) => {
      const evs = byEstimate.get(e.id) ?? [];
      const videoSent = evs.find((ev) => ev.kind === "video_sent" && !(ev.meta as { suppressed?: string }).suppressed);
      return {
        templateVersion: e.templateVersion ?? "retail-v1",
        tier: e.selectedTier,
        opened: evs.some((ev) => ev.kind === "open"),
        accepted: e.status === "accepted",
        videoPersonalized: videoSent ? Boolean((videoSent.meta as { personalized?: boolean }).personalized) : null,
      };
    });
  });
}
