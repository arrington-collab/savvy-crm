import { describe, it, expect } from "vitest";
import { summarizeLedgerProgress } from "./job-ledger";

describe("summarizeLedgerProgress", () => {
  it("counts done and verified tasks as complete", () => {
    const p = summarizeLedgerProgress([
      { status: "verified" }, { status: "done" }, { status: "pending" }, { status: "blocked" },
    ]);
    expect(p.total).toBe(4);
    expect(p.complete).toBe(2);
    expect(p.pct).toBe(50);
  });

  it("does not count exception or in-progress tasks as complete", () => {
    const p = summarizeLedgerProgress([{ status: "exception" }, { status: "in_progress" }, { status: "pending" }]);
    expect(p.complete).toBe(0);
    expect(p.pct).toBe(0);
  });

  it("rounds the percentage", () => {
    const p = summarizeLedgerProgress([{ status: "done" }, { status: "pending" }, { status: "pending" }]);
    expect(p.pct).toBe(33); // 1/3
  });

  it("is zero (not NaN) for an empty ledger", () => {
    expect(summarizeLedgerProgress([])).toEqual({ total: 0, complete: 0, pct: 0 });
  });
});
