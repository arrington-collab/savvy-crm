import { and, eq, inArray, gte, lt } from "drizzle-orm";
import { metricValue, rankStandings, settleWinner, type ChallengeMetric, type Standing } from "@savvy/core";
import type { Tx } from "../tenant";
import { canvassChallenge, canvassChallengeParticipant, canvassKnock } from "../schema/index";

export interface CreateChallengeArgs {
  tenantId: string;
  createdByRepId: string;
  kind: "h2h" | "koth" | "contest";
  metric: ChallengeMetric;
  windowStart: Date;
  windowEnd: Date;
  participantRepIds: string[];
  meta?: Record<string, unknown>;
}

export interface ChallengeRow {
  id: string;
  kind: string;
  metric: string;
  status: string;
  createdByRepId: string;
  windowStart: Date;
  windowEnd: Date;
  winnerRepId: string | null;
  meta: Record<string, unknown>;
  participantIds: string[];
}

// h2h waits for the opponent to accept; koth/contest start active.
export async function createChallenge(tx: Tx, a: CreateChallengeArgs): Promise<{ id: string }> {
  const status = a.kind === "h2h" ? "pending" : "active";
  const [ch] = await tx
    .insert(canvassChallenge)
    .values({
      tenantId: a.tenantId, kind: a.kind, metric: a.metric, status,
      createdByRepId: a.createdByRepId, windowStart: a.windowStart, windowEnd: a.windowEnd,
      meta: a.meta ?? {},
    })
    .returning({ id: canvassChallenge.id });
  const id = ch!.id;
  // creator auto-accepts; for koth/contest everyone is in immediately, for h2h
  // the opponent's acceptedAt stays null until they accept.
  const now = new Date();
  await tx.insert(canvassChallengeParticipant).values(
    a.participantRepIds.map((repId) => ({
      tenantId: a.tenantId,
      challengeId: id,
      repId,
      acceptedAt: repId === a.createdByRepId || a.kind !== "h2h" ? now : null,
    })),
  );
  return { id };
}

export async function acceptChallenge(tx: Tx, tenantId: string, challengeId: string, repId: string): Promise<boolean> {
  const rows = await tx
    .update(canvassChallengeParticipant)
    .set({ acceptedAt: new Date() })
    .where(and(eq(canvassChallengeParticipant.challengeId, challengeId), eq(canvassChallengeParticipant.repId, repId)))
    .returning({ id: canvassChallengeParticipant.id });
  if (rows.length === 0) return false;
  await tx
    .update(canvassChallenge)
    .set({ status: "active" })
    .where(and(eq(canvassChallenge.id, challengeId), eq(canvassChallenge.status, "pending")));
  return true;
}

export async function setChallengeStatus(tx: Tx, tenantId: string, challengeId: string, status: string): Promise<void> {
  await tx.update(canvassChallenge).set({ status }).where(eq(canvassChallenge.id, challengeId));
}

export async function listChallenges(tx: Tx, tenantId: string): Promise<ChallengeRow[]> {
  const chs = await tx.select().from(canvassChallenge);
  if (chs.length === 0) return [];
  const parts = await tx.select().from(canvassChallengeParticipant);
  return chs.map((c) => ({
    id: c.id, kind: c.kind, metric: c.metric, status: c.status,
    createdByRepId: c.createdByRepId, windowStart: c.windowStart, windowEnd: c.windowEnd,
    winnerRepId: c.winnerRepId, meta: c.meta,
    participantIds: parts.filter((p) => p.challengeId === c.id).map((p) => p.repId),
  }));
}

// Live standings from each participant's knocks within the window.
export async function standingsFor(tx: Tx, tenantId: string, ch: ChallengeRow): Promise<Standing[]> {
  if (ch.participantIds.length === 0) return [];
  const rows = await tx
    .select({ repId: canvassKnock.repId, outcome: canvassKnock.outcome, amount: canvassKnock.amount })
    .from(canvassKnock)
    .where(and(
      inArray(canvassKnock.repId, ch.participantIds),
      gte(canvassKnock.createdAt, ch.windowStart),
      lt(canvassKnock.createdAt, ch.windowEnd),
    ));
  const scores = ch.participantIds.map((repId) => ({
    repId,
    score: metricValue(rows.filter((r) => r.repId === repId), ch.metric as ChallengeMetric),
  }));
  return rankStandings(scores);
}

// Settle every active challenge whose window has ended: stamp final scores,
// winner, status. Returns how many were settled.
export async function settleDueChallenges(tx: Tx, tenantId: string, now: Date): Promise<number> {
  const due = (await listChallenges(tx, tenantId)).filter((c) => c.status === "active" && c.windowEnd <= now);
  for (const ch of due) {
    const standings = await standingsFor(tx, tenantId, ch);
    for (const s of standings) {
      await tx
        .update(canvassChallengeParticipant)
        .set({ finalScore: s.score })
        .where(and(eq(canvassChallengeParticipant.challengeId, ch.id), eq(canvassChallengeParticipant.repId, s.repId)));
    }
    await tx
      .update(canvassChallenge)
      .set({ status: "settled", winnerRepId: settleWinner(standings), settledAt: now })
      .where(eq(canvassChallenge.id, ch.id));
  }
  return due.length;
}
