import { describe, expect, it } from "vitest";
import { scoreKnock, scoreRep, DEFAULT_POINT_WEIGHTS, levelFor } from "./canvass-points";

describe("scoreKnock", () => {
  it("scores each outcome cumulatively with the default weights", () => {
    expect(scoreKnock({ outcome: "noanswer" })).toBe(1); // door only
    expect(scoreKnock({ outcome: "notint" })).toBe(3); // door + contact
    expect(scoreKnock({ outcome: "callback" })).toBe(6); // door + contact + callback
    expect(scoreKnock({ outcome: "appt" })).toBe(13); // door + contact + appt
    expect(scoreKnock({ outcome: "sale", amount: 0 })).toBe(28); // door + contact + sale
  });
  it("adds a revenue bonus of 1 per $1000, capped at 25", () => {
    expect(scoreKnock({ outcome: "sale", amount: 12000 })).toBe(28 + 12);
    expect(scoreKnock({ outcome: "sale", amount: 999 })).toBe(28 + 0);
    expect(scoreKnock({ outcome: "sale", amount: 999999 })).toBe(28 + 25); // capped
  });
});

describe("scoreRep", () => {
  it("sums points across a rep's knocks", () => {
    const knocks = [{ outcome: "noanswer" }, { outcome: "appt" }, { outcome: "sale", amount: 5000 }];
    expect(scoreRep(knocks)).toBe(1 + 13 + (28 + 5));
  });
  it("is 0 for no knocks", () => {
    expect(scoreRep([])).toBe(0);
  });
});

describe("levelFor", () => {
  it("returns the tier for a point total and progress to the next", () => {
    const rookie = levelFor(0);
    expect(rookie.tier).toBe("Rookie");
    expect(rookie.next).toBe("Runner");
    expect(rookie.pointsToNext).toBe(500);
    expect(rookie.progressPct).toBe(0);

    const mid = levelFor(1250); // between Runner (500) and Closer (2000)
    expect(mid.tier).toBe("Runner");
    expect(mid.next).toBe("Closer");
    expect(mid.pointsToNext).toBe(750);
    expect(mid.progressPct).toBe(50); // (1250-500)/(2000-500) = 50%
  });
  it("caps at the top tier with no next", () => {
    const top = levelFor(20000);
    expect(top.tier).toBe("Legend");
    expect(top.next).toBeNull();
    expect(top.pointsToNext).toBeNull();
    expect(top.progressPct).toBe(100);
  });
});
