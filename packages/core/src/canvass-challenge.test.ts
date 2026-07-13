import { describe, expect, it } from "vitest";
import { rankStandings, settleWinner, h2hRecord } from "./canvass-challenge";

describe("rankStandings", () => {
  it("sorts by score desc and assigns 1-based rank", () => {
    const r = rankStandings([{ repId: "a", score: 5 }, { repId: "b", score: 9 }, { repId: "c", score: 5 }]);
    expect(r.map((x) => x.repId)).toEqual(["b", "a", "c"]);
    expect(r.map((x) => x.rank)).toEqual([1, 2, 3]);
  });
});

describe("settleWinner", () => {
  it("returns the unique top scorer, or null on a tie/empty", () => {
    expect(settleWinner([{ repId: "a", score: 5 }, { repId: "b", score: 9 }])).toBe("b");
    expect(settleWinner([{ repId: "a", score: 5 }, { repId: "b", score: 5 }])).toBeNull(); // tie
    expect(settleWinner([])).toBeNull();
  });
});

describe("h2hRecord", () => {
  it("counts wins/losses for a rep across settled h2h results", () => {
    const results = [
      { winnerRepId: "a", participantIds: ["a", "b"] },
      { winnerRepId: "b", participantIds: ["a", "b"] },
      { winnerRepId: null, participantIds: ["a", "b"] }, // draw
      { winnerRepId: "a", participantIds: ["a", "c"] },
    ];
    expect(h2hRecord(results, "a")).toEqual({ wins: 2, losses: 1 }); // won 2, lost 1, 1 draw ignored
  });
});
