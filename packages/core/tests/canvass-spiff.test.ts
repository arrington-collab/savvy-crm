import { describe, expect, it } from "vitest";
import { settlementSpiffs, SPIFF_KINDS, SPIFF_STATUSES } from "../src/canvass-spiff";

const st = (repId: string, score: number, rank: number) => ({ repId, score, rank });

describe("SPIFF constants", () => {
  it("exposes kinds and statuses", () => {
    expect(SPIFF_KINDS).toEqual(["wager", "contest_prize", "manual"]);
    expect(SPIFF_STATUSES).toEqual(["owed", "paid", "void"]);
  });
});

describe("settlementSpiffs — wager (h2h/koth)", () => {
  it("loser owes winner the wager amount", () => {
    const ch = { kind: "h2h", meta: { wagerCents: 2000 } };
    const standings = [st("A", 30, 1), st("B", 10, 2)];
    const out = settlementSpiffs(ch, standings, "A");
    expect(out).toEqual([
      { kind: "wager", amountCents: 2000, winnerRepId: "A", fromRepId: "B" },
    ]);
  });

  it("emits one wager row per loser in a koth (all losers owe the winner)", () => {
    const ch = { kind: "koth", meta: { wagerCents: 500 } };
    const standings = [st("A", 30, 1), st("B", 20, 2), st("C", 10, 3)];
    const out = settlementSpiffs(ch, standings, "A");
    expect(out).toEqual([
      { kind: "wager", amountCents: 500, winnerRepId: "A", fromRepId: "B" },
      { kind: "wager", amountCents: 500, winnerRepId: "A", fromRepId: "C" },
    ]);
  });

  it("no spiffs when wager is absent, zero, or there is no winner (tie)", () => {
    expect(settlementSpiffs({ kind: "h2h", meta: {} }, [st("A", 1, 1), st("B", 1, 1)], "A")).toEqual([]);
    expect(settlementSpiffs({ kind: "h2h", meta: { wagerCents: 0 } }, [st("A", 3, 1), st("B", 1, 2)], "A")).toEqual([]);
    expect(settlementSpiffs({ kind: "h2h", meta: { wagerCents: 2000 } }, [st("A", 1, 1), st("B", 1, 1)], null)).toEqual([]);
  });
});

describe("settlementSpiffs — contest prize", () => {
  it("whole pool goes to the single winner, from_rep null", () => {
    const ch = { kind: "contest", meta: { prizePoolCents: 10000 } };
    const standings = [st("A", 50, 1), st("B", 20, 2), st("C", 10, 3)];
    const out = settlementSpiffs(ch, standings, "A");
    expect(out).toEqual([
      { kind: "contest_prize", amountCents: 10000, winnerRepId: "A", fromRepId: null },
    ]);
  });

  it("no prize spiff without a pool or without a winner", () => {
    expect(settlementSpiffs({ kind: "contest", meta: {} }, [st("A", 5, 1)], "A")).toEqual([]);
    expect(settlementSpiffs({ kind: "contest", meta: { prizePoolCents: 5000 } }, [], null)).toEqual([]);
  });
});
