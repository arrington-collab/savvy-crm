export const CHALLENGE_KINDS = ["h2h", "koth", "contest"] as const;
export type ChallengeKind = (typeof CHALLENGE_KINDS)[number];

export const CHALLENGE_STATUSES = ["pending", "active", "settled", "declined", "cancelled"] as const;
export type ChallengeStatus = (typeof CHALLENGE_STATUSES)[number];

export interface Standing {
  repId: string;
  score: number;
  rank: number;
}

/** Sort participants by score desc; 1-based rank (ties share order but get distinct ranks by input order). */
export function rankStandings(scores: { repId: string; score: number }[]): Standing[] {
  return [...scores]
    .sort((a, b) => b.score - a.score)
    .map((s, i) => ({ repId: s.repId, score: s.score, rank: i + 1 }));
}

/** The unique top scorer, or null if the top score is tied or there are no scores. */
export function settleWinner(scores: { repId: string; score: number }[]): string | null {
  if (scores.length === 0) return null;
  const ranked = rankStandings(scores);
  if (ranked.length >= 2 && ranked[0]!.score === ranked[1]!.score) return null; // tie at the top
  return ranked[0]!.repId;
}

/** W/L for a rep across settled h2h results (draws — winnerRepId null — ignored). */
export function h2hRecord(
  results: { winnerRepId: string | null; participantIds: string[] }[],
  repId: string,
): { wins: number; losses: number } {
  let wins = 0;
  let losses = 0;
  for (const r of results) {
    if (!r.participantIds.includes(repId) || r.winnerRepId == null) continue;
    if (r.winnerRepId === repId) wins++;
    else losses++;
  }
  return { wins, losses };
}
