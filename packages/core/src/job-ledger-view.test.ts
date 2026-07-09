import { describe, it, expect } from "vitest";
import { effectiveMode, ledgerGlyph, isManual, groupLedgerByPhase, currentPhase, firstUnblockedIncomplete } from "./job-ledger-view";

describe("effectiveMode", () => {
  it("prefers the tenant override", () => expect(effectiveMode("full_auto", "manual")).toBe("manual"));
  it("falls back to default", () => expect(effectiveMode("assisted", null)).toBe("assisted"));
});

describe("ledgerGlyph", () => {
  it("pending with a blocker renders blocked", () => expect(ledgerGlyph("pending", [3]).state).toBe("blocked"));
  it("pending with no blocker renders pending", () => expect(ledgerGlyph("pending", []).state).toBe("pending"));
  it("verified renders verified", () => expect(ledgerGlyph("verified", []).state).toBe("verified"));
  it("not_applicable renders na", () => expect(ledgerGlyph("not_applicable", []).state).toBe("na"));
});

describe("groupLedgerByPhase + currentPhase", () => {
  const rows = [
    { taskId: 1, phase: 1, status: "verified", blockedBy: [] },
    { taskId: 2, phase: 1, status: "done", blockedBy: [] },
    { taskId: 3, phase: 2, status: "pending", blockedBy: [] },
    { taskId: 4, phase: 2, status: "pending", blockedBy: [3] },
  ] as const;
  it("collapses a fully-terminal phase", () => {
    const g = groupLedgerByPhase(rows as never);
    expect(g.find((x) => x.phase === 1)?.collapsed).toBe(true);
    expect(g.find((x) => x.phase === 2)?.collapsed).toBe(false);
  });
  it("opens at the first incomplete phase", () => {
    expect(currentPhase(groupLedgerByPhase(rows as never))).toBe(2);
  });
});

describe("firstUnblockedIncomplete", () => {
  it("skips blocked and terminal rows", () => {
    const rows = [
      { taskId: 1, phase: 1, status: "done", blockedBy: [] },
      { taskId: 4, phase: 2, status: "pending", blockedBy: [3] },
      { taskId: 5, phase: 2, status: "pending", blockedBy: [] },
    ];
    expect(firstUnblockedIncomplete(rows as never)?.taskId).toBe(5);
  });
});
