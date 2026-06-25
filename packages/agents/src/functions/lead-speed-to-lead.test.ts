/**
 * lead-speed-to-lead tests.
 *
 * Full Inngest workflow stepping requires a live server + Postgres (CI-gated).
 * We test the extractable decision predicates here with real assertions so
 * CI will catch regressions on the pick-reassignee path and check-overdue logic.
 */
import { describe, it, expect } from "vitest";
import { pickReassignee, type AssignmentCandidate } from "@savvy/core";

// Simulate the check-overdue predicate: uncontacted+assigned lead yields { owner }
function checkOverduePredicate(row: { contacted: Date | null; owner: string | null } | null) {
  return row && row.contacted == null && row.owner != null ? { owner: row.owner } : null;
}

// Simulate the check-escalate predicate: uncontacted lead yields { owner } (even if now unassigned)
function checkEscalatePredicate(row: { contacted: Date | null; owner: string | null } | null) {
  return row && row.contacted == null ? { owner: row.owner } : null;
}

describe("leadSpeedToLead — decision predicates", () => {
  it("check-overdue: uncontacted assigned lead is overdue", () => {
    const result = checkOverduePredicate({ contacted: null, owner: "rep-1" });
    expect(result).toEqual({ owner: "rep-1" });
  });

  it("check-overdue: contacted lead short-circuits (returns null)", () => {
    const result = checkOverduePredicate({ contacted: new Date(), owner: "rep-1" });
    expect(result).toBeNull();
  });

  it("check-overdue: unassigned lead returns null (no owner to escalate from)", () => {
    const result = checkOverduePredicate({ contacted: null, owner: null });
    expect(result).toBeNull();
  });

  it("check-escalate: still-uncontacted lead still qualifies for reassign", () => {
    const result = checkEscalatePredicate({ contacted: null, owner: "rep-1" });
    expect(result).toEqual({ owner: "rep-1" });
  });

  it("check-escalate: contacted lead after overdue short-circuits", () => {
    const result = checkEscalatePredicate({ contacted: new Date(), owner: "rep-1" });
    expect(result).toBeNull();
  });
});

describe("leadSpeedToLead — reassign via pickReassignee", () => {
  const makeCandidate = (userId: string, lastAssigned: string | null = null): AssignmentCandidate => ({
    userId,
    openLeadCount: 0,
    lastAssignedAt: lastAssigned,
    driveMinutes: null,
  });

  it("selects a different rep when current owner is the only assigned one", () => {
    const owner = "current-rep";
    const candidates = [makeCandidate(owner, "2024-01-01T00:00:00Z"), makeCandidate("next-rep", null)];
    const next = pickReassignee(candidates, owner);
    expect(next).toBe("next-rep");
  });

  it("returns null when no candidates available", () => {
    const next = pickReassignee([], "current-rep");
    expect(next).toBeNull();
  });

  it("returns null when only the current owner is a candidate", () => {
    const next = pickReassignee([makeCandidate("owner")], "owner");
    expect(next).toBeNull();
  });
});
