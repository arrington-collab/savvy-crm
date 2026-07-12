import { describe, expect, it } from "vitest";
import { scoreKnock, scoreRep, DEFAULT_POINT_WEIGHTS } from "./canvass-points";

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
