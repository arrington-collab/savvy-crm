// Points derived from a knock's outcome (Approach A: knocks are the source of
// truth). Cumulative: a sale also earns the door + contact points.
export interface CanvassPointWeights {
  door: number;
  contact: number; // any answer (outcome !== "noanswer")
  callback: number;
  appt: number;
  sale: number;
  revenuePer: number; // dollars per bonus point
  revenueCap: number; // max revenue bonus points
}

export const DEFAULT_POINT_WEIGHTS: CanvassPointWeights = {
  door: 1,
  contact: 2,
  callback: 3,
  appt: 10,
  sale: 25,
  revenuePer: 1000,
  revenueCap: 25,
};

export interface ScoredKnockLike {
  outcome: string;
  amount?: number | null;
}

export function scoreKnock(k: ScoredKnockLike, w: CanvassPointWeights = DEFAULT_POINT_WEIGHTS): number {
  let p = w.door;
  if (k.outcome !== "noanswer") p += w.contact;
  if (k.outcome === "callback") p += w.callback;
  if (k.outcome === "appt") p += w.appt;
  if (k.outcome === "sale") {
    p += w.sale;
    p += Math.min(w.revenueCap, Math.floor((k.amount ?? 0) / w.revenuePer));
  }
  return p;
}

export function scoreRep(knocks: ScoredKnockLike[], w: CanvassPointWeights = DEFAULT_POINT_WEIGHTS): number {
  return knocks.reduce((sum, k) => sum + scoreKnock(k, w), 0);
}

export const LEVEL_TIERS = [
  { tier: "Rookie", min: 0 },
  { tier: "Runner", min: 500 },
  { tier: "Closer", min: 2000 },
  { tier: "Veteran", min: 6000 },
  { tier: "Legend", min: 15000 },
] as const;

export interface RepLevel {
  tier: string;
  next: string | null;
  pointsToNext: number | null;
  progressPct: number;
}

export function levelFor(points: number): RepLevel {
  let idx = 0;
  for (let i = 0; i < LEVEL_TIERS.length; i++) {
    if (points >= LEVEL_TIERS[i]!.min) idx = i;
  }
  const cur = LEVEL_TIERS[idx]!;
  const nextTier = LEVEL_TIERS[idx + 1];
  if (!nextTier) return { tier: cur.tier, next: null, pointsToNext: null, progressPct: 100 };
  const span = nextTier.min - cur.min;
  const into = points - cur.min;
  return {
    tier: cur.tier,
    next: nextTier.tier,
    pointsToNext: nextTier.min - points,
    progressPct: Math.max(0, Math.min(100, Math.round((into / span) * 100))),
  };
}
