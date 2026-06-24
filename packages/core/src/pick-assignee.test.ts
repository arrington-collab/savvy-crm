import { describe, it, expect } from "vitest";
import { pickAssignee, type AssignmentCandidate } from "./pick-assignee";
import type { AssignmentConfig } from "./lead-assignment";

const c = (userId: string, openLeadCount: number, lastAssignedAt: string | null): AssignmentCandidate =>
  ({ userId, openLeadCount, lastAssignedAt });
const lead = { state: "AZ", city: "Mesa", score: 70 };

describe("pickAssignee", () => {
  const cands = [c("a", 5, "2026-01-01"), c("b", 2, "2026-02-01"), c("d", 2, "2026-01-15")];

  it("returns null when off or no candidates", () => {
    expect(pickAssignee({ strategy: "off", config: { strategy: "off" }, candidates: cands, lead })).toBeNull();
    expect(pickAssignee({ strategy: "least_loaded", config: { strategy: "least_loaded" }, candidates: [], lead })).toBeNull();
  });
  it("least_loaded picks fewest open, tie -> oldest lastAssignedAt", () => {
    expect(pickAssignee({ strategy: "least_loaded", config: { strategy: "least_loaded" }, candidates: cands, lead })).toBe("d");
  });
  it("round_robin picks the least-recently-assigned (null = never -> first)", () => {
    const withNever = [c("a", 9, "2026-03-01"), c("z", 0, null)];
    expect(pickAssignee({ strategy: "round_robin", config: { strategy: "round_robin" }, candidates: withNever, lead })).toBe("z");
  });
  it("territory: city+state rule beats state-only; falls back to least_loaded on no match", () => {
    const config: AssignmentConfig = { strategy: "territory", territoryRules: [
      { state: "AZ", userId: "a" },
      { state: "AZ", city: "Mesa", userId: "b" },
    ] };
    expect(pickAssignee({ strategy: "territory", config, candidates: cands, lead })).toBe("b");
    const noMatch = pickAssignee({ strategy: "territory", config, candidates: cands, lead: { state: "TX", city: "Austin", score: 50 } });
    expect(noMatch).toBe("d");
  });
  it("score: highest tier the lead meets; within tier least_loaded; fallback when no tier", () => {
    const config: AssignmentConfig = { strategy: "score", scoreTiers: [
      { minScore: 80, userIds: ["a"] },
      { minScore: 50, userIds: ["b", "d"] },
    ] };
    expect(pickAssignee({ strategy: "score", config, candidates: cands, lead })).toBe("d");
    const hot = pickAssignee({ strategy: "score", config, candidates: cands, lead: { ...lead, score: 95 } });
    expect(hot).toBe("a");
  });
});
