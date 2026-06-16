import { describe, it, expect } from "vitest";
import { summarizeRepPerformance } from "./rep-performance";

describe("summarizeRepPerformance", () => {
  it("aggregates per rep + team rollup", () => {
    const rows = [
      { userId: "u1", name: "Ann", stage: "approved", valueCents: 100000, daysToClose: 10 },
      { userId: "u1", name: "Ann", stage: "lead", valueCents: 0, daysToClose: null },
      { userId: "u2", name: "Bo", stage: "approved", valueCents: 200000, daysToClose: 20 },
    ];
    const out = summarizeRepPerformance(rows);
    const ann = out.reps.find((r) => r.userId === "u1")!;
    expect(ann.jobsAssigned).toBe(2);
    expect(ann.approved).toBe(1);
    expect(ann.totalValueCents).toBe(100000);
    expect(ann.avgDaysToClose).toBeCloseTo(10);
    expect(out.team.jobsAssigned).toBe(3);
    expect(out.team.approved).toBe(2);
    expect(out.team.totalValueCents).toBe(300000);
  });
});
