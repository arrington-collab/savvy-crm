import { describe, it, expect } from "vitest";
import { parseReplayDate, replayDayBounds, revealedRunCount } from "./replay";

describe("parseReplayDate", () => {
  it("accepts a valid YYYY-MM-DD", () => {
    expect(parseReplayDate("2026-07-15")).toBe("2026-07-15");
  });
  it("rejects junk, null, and non-real calendar dates", () => {
    for (const v of [null, undefined, "", "2026-7-5", "2026-13-01", "2026-02-30", "2026/07/15", "nope", "20260715"]) {
      expect(parseReplayDate(v as string | null | undefined)).toBeNull();
    }
  });
});

describe("replayDayBounds", () => {
  it("[00:00 local, 00:00 next-day local) in Phoenix (UTC-7)", () => {
    const { start, end } = replayDayBounds("2026-07-15", "America/Phoenix");
    expect(start.toISOString()).toBe("2026-07-15T07:00:00.000Z");
    expect(end.toISOString()).toBe("2026-07-16T07:00:00.000Z");
  });
});

describe("revealedRunCount", () => {
  const start = Date.UTC(2026, 6, 15, 7);
  const end = start + 24 * 3600 * 1000;
  const at = (frac: number) => start + frac * (end - start);
  const runs = [at(0.1), at(0.25), at(0.5), at(0.9)]; // ASC

  it("reveals none at progress 0 (all runs are after start)", () => {
    expect(revealedRunCount(runs, start, end, 0)).toBe(0);
  });
  it("reveals all at progress 1", () => {
    expect(revealedRunCount(runs, start, end, 1)).toBe(4);
  });
  it("reveals by startedAt cutoff (inclusive)", () => {
    expect(revealedRunCount(runs, start, end, 0.3)).toBe(2); // 0.1, 0.25
    expect(revealedRunCount(runs, start, end, 0.5)).toBe(3); // includes exactly-0.5
  });
  it("clamps progress out of range", () => {
    expect(revealedRunCount(runs, start, end, -1)).toBe(0);
    expect(revealedRunCount(runs, start, end, 5)).toBe(4);
  });
  it("is monotonic non-decreasing in progress", () => {
    let prev = -1;
    for (let p = 0; p <= 1.0001; p += 0.05) {
      const c = revealedRunCount(runs, start, end, p);
      expect(c).toBeGreaterThanOrEqual(prev);
      prev = c;
    }
  });
  it("empty day -> 0", () => {
    expect(revealedRunCount([], start, end, 1)).toBe(0);
  });
});
