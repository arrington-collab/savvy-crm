import { describe, it, expect } from "vitest";
import { computeVelocity } from "./velocity";

describe("computeVelocity", () => {
  it("averages days between consecutive stage entries and total cycle time", () => {
    const events = [
      { jobId: "j1", toStage: "lead", enteredAt: new Date("2026-01-01T00:00:00Z") },
      { jobId: "j1", toStage: "inspected", enteredAt: new Date("2026-01-03T00:00:00Z") }, // 2d in lead
      { jobId: "j1", toStage: "approved", enteredAt: new Date("2026-01-07T00:00:00Z") }, // 4d in inspected
    ];
    const v = computeVelocity(events);
    expect(v.perStageAvgDays.lead).toBeCloseTo(2);
    expect(v.perStageAvgDays.inspected).toBeCloseTo(4);
    expect(v.cycleTimeDays).toBeCloseTo(6); // first -> last
  });
  it("handles empty input", () => {
    expect(computeVelocity([])).toEqual({ perStageAvgDays: {}, cycleTimeDays: 0 });
  });
});
