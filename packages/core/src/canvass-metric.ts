import { scoreRep, DEFAULT_POINT_WEIGHTS, type ScoredKnockLike, type CanvassPointWeights } from "./canvass-points";

// The metrics a challenge/leaderboard can compete on. One function so standings,
// leaderboards, and challenges all agree.
export const CHALLENGE_METRICS = ["points", "doors", "contacts", "appts", "sales", "revenue"] as const;
export type ChallengeMetric = (typeof CHALLENGE_METRICS)[number];

export function metricValue(
  knocks: ScoredKnockLike[],
  metric: ChallengeMetric,
  w: CanvassPointWeights = DEFAULT_POINT_WEIGHTS,
): number {
  switch (metric) {
    case "points":
      return scoreRep(knocks, w);
    case "doors":
      return knocks.length;
    case "contacts":
      return knocks.filter((k) => k.outcome !== "noanswer").length;
    case "appts":
      return knocks.filter((k) => k.outcome === "appt").length;
    case "sales":
      return knocks.filter((k) => k.outcome === "sale").length;
    case "revenue":
      return knocks.filter((k) => k.outcome === "sale").reduce((s, k) => s + (k.amount ?? 0), 0);
  }
}
