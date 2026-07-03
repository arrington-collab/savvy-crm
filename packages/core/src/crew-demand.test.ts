import { describe, it, expect } from "vitest";
import { assessCrewDemand } from "./crew-demand";

describe("assessCrewDemand", () => {
  it("does not recommend when the install backlog fits the crews' build capacity", () => {
    // 2 crews × 5 workdays = 10 installs of capacity; 8 pending → fine.
    const r = assessCrewDemand({ pendingInstalls: 8, crewCount: 2, workdaysInWindow: 5 });
    expect(r).toMatchObject({ buildCapacity: 10, recommendAnotherCrew: false, suggestedCrews: 0 });
  });

  it("recommends another crew when demand outruns build capacity, sized to the deficit", () => {
    // 2 crews × 5 = 10 capacity; 17 pending → deficit 7 → ceil(7/5) = 2 more crews.
    const r = assessCrewDemand({ pendingInstalls: 17, crewCount: 2, workdaysInWindow: 5 });
    expect(r.buildCapacity).toBe(10);
    expect(r.recommendAnotherCrew).toBe(true);
    expect(r.suggestedCrews).toBe(2);
  });

  it("recommends hiring when there are pending installs but no crews", () => {
    const r = assessCrewDemand({ pendingInstalls: 4, crewCount: 0, workdaysInWindow: 5 });
    expect(r).toMatchObject({ buildCapacity: 0, recommendAnotherCrew: true, suggestedCrews: 1 });
  });

  it("never recommends when there is no backlog", () => {
    expect(assessCrewDemand({ pendingInstalls: 0, crewCount: 1, workdaysInWindow: 5 }).recommendAnotherCrew).toBe(false);
  });
});
