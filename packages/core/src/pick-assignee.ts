import type { AssignmentConfig } from "./lead-assignment";

export type AssignmentCandidate = {
  userId: string;
  openLeadCount: number;
  lastAssignedAt: string | null;
  driveMinutes?: number | null;
  skills?: string[];
};

const ts = (s: string | null): number => (s ? Date.parse(s) : 0);

/** fewest open leads; tie -> least recently assigned (null = oldest). */
function leastLoaded(cands: AssignmentCandidate[]): string | null {
  if (cands.length === 0) return null;
  return [...cands].sort((a, b) => a.openLeadCount - b.openLeadCount || ts(a.lastAssignedAt) - ts(b.lastAssignedAt))[0]!.userId;
}

/** least recently assigned (null = never -> first). */
function roundRobin(cands: AssignmentCandidate[]): string | null {
  if (cands.length === 0) return null;
  return [...cands].sort((a, b) => ts(a.lastAssignedAt) - ts(b.lastAssignedAt))[0]!.userId;
}

export function pickAssignee(opts: {
  strategy: AssignmentConfig["strategy"];
  config: AssignmentConfig;
  candidates: AssignmentCandidate[];
  lead: { state: string | null; city: string | null; zip?: string | null; score: number | null; lane?: string | null };
}): string | null {
  const { strategy, config, candidates, lead } = opts;
  if (strategy === "off" || candidates.length === 0) return null;

  const byId = new Map(candidates.map((c) => [c.userId, c]));
  const inPool = (ids: string[]): AssignmentCandidate[] =>
    ids.map((id) => byId.get(id)).filter((c): c is AssignmentCandidate => Boolean(c));

  if (strategy === "round_robin") return roundRobin(candidates);
  if (strategy === "least_loaded") return leastLoaded(candidates);

  if (strategy === "territory") {
    const rules = config.territoryRules ?? [];
    // 1) exact zip match wins
    const zipRules = lead.zip ? rules.filter((r) => r.zip != null && r.zip === lead.zip) : [];
    if (zipRules.length > 0) {
      return roundRobin(inPool(zipRules.map((r) => r.userId))) ?? roundRobin(candidates);
    }
    // 2) state (+ optional city) rules
    const stateRules = rules.filter((r) => r.zip == null && r.state === lead.state && (r.city == null || r.city === lead.city));
    const cityRules = stateRules.filter((r) => r.city != null && r.city === lead.city);
    const chosen = cityRules.length > 0 ? cityRules : stateRules;
    // 3) round-robin tiebreak within the matched pool, else across everyone
    return roundRobin(inPool(chosen.map((r) => r.userId))) ?? roundRobin(candidates);
  }

  if (strategy === "score") {
    const tiers = (config.scoreTiers ?? [])
      .filter((t) => (lead.score ?? 0) >= t.minScore)
      .sort((a, b) => b.minScore - a.minScore);
    const top = tiers[0];
    const matched = top ? inPool(top.userIds) : [];
    return leastLoaded(matched) ?? leastLoaded(candidates);
  }
  if (strategy === "proximity") {
    let pool = candidates;
    if (lead.lane) {
      const skilled = candidates.filter((c) => (c.skills ?? []).includes(lead.lane!));
      if (skilled.length > 0) pool = skilled;
    }
    const ranked = [...pool].sort((a, b) => {
      const da = a.driveMinutes ?? Number.POSITIVE_INFINITY;
      const db = b.driveMinutes ?? Number.POSITIVE_INFINITY;
      return da - db || a.openLeadCount - b.openLeadCount || ts(a.lastAssignedAt) - ts(b.lastAssignedAt);
    });
    return ranked[0]?.userId ?? null;
  }
  return null;
}

// Pick a DIFFERENT owner for SLA escalation: least-recently-assigned among the others.
export function pickReassignee(candidates: AssignmentCandidate[], currentOwnerId: string | null): string | null {
  const others = candidates.filter((c) => c.userId !== currentOwnerId);
  return roundRobin(others);
}
