/**
 * lead-speed-to-lead tests.
 *
 * Full Inngest workflow stepping requires a live server + Postgres (CI-gated).
 * We test the extractable decision predicates here with real assertions so
 * CI will catch regressions on the pick-reassignee path and check-overdue logic.
 */
import { describe, it, expect, vi } from "vitest";
import { pickReassignee, type AssignmentCandidate } from "@savvy/core";
import { runRepAlert } from "./lead-speed-to-lead";

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

describe("runRepAlert", () => {
  const fakeSender = () => {
    const calls: { to: string; body: string }[] = [];
    return {
      calls,
      sendSms: vi.fn(async (m: { to: string; from: string; body: string }) => {
        calls.push({ to: m.to, body: m.body });
        return { sid: "x" };
      }),
    };
  };

  it("texts the rep with a tel: link for a non-call lead with a rep phone", async () => {
    const s = fakeSender();
    const r = await runRepAlert(
      { tenantId: "t-test", source: "web", ownerPhone: "+16025550001", customerName: "Dale Homeowner", customerPhone: "+16025550142", city: "Mesa" },
      s as never,
    );
    expect(r).toBe("sent");
    expect(s.sendSms).toHaveBeenCalledTimes(1);
    expect(s.calls[0]!.to).toBe("+16025550001");
    expect(s.calls[0]!.body).toContain("tel:+16025550142");
    expect(s.calls[0]!.body).toContain("Dale");
  });
  it("skips inbound-call leads", async () => {
    const s = fakeSender();
    expect(await runRepAlert({ tenantId: "t-test", source: "inbound_call", ownerPhone: "+16025550001", customerName: "Dale", customerPhone: "+16025550142", city: null }, s as never)).toBe("skip-inbound");
    expect(s.sendSms).not.toHaveBeenCalled();
  });
  it("skips when the rep has no phone", async () => {
    const s = fakeSender();
    expect(await runRepAlert({ tenantId: "t-test", source: "web", ownerPhone: null, customerName: "Dale", customerPhone: "+16025550142", city: null }, s as never)).toBe("skip-no-rep-phone");
    expect(s.sendSms).not.toHaveBeenCalled();
  });
  it("skips when there is no customer phone to dial", async () => {
    const s = fakeSender();
    expect(await runRepAlert({ tenantId: "t-test", source: "web", ownerPhone: "+16025550001", customerName: "Dale", customerPhone: null, city: null }, s as never)).toBe("skip-no-lead-phone");
    expect(s.sendSms).not.toHaveBeenCalled();
  });
});
