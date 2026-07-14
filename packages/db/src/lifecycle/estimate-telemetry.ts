// Estimate Experience slice 4: first-party page telemetry. Events are stored
// on the estimate (evidence + NOVA's race trigger) — never a third party.

import { and, eq, inArray } from "drizzle-orm";
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
