import { describe, test, expect } from "vitest";
import { pulseDurationSeconds, coverageWins, justCompleted, ORB_IDLE_SECONDS, ORB_MIN_SECONDS } from "./showcase-motion";
import type { EvidenceStatus } from "./enums";

describe("pulseDurationSeconds", () => {
  test("0 runs/hour -> the slow idle breath (not the min floor)", () => {
    expect(pulseDurationSeconds(0)).toBe(ORB_IDLE_SECONDS);
    expect(pulseDurationSeconds(-5)).toBe(ORB_IDLE_SECONDS); // guard nonsense input
  });

  test("never pulses faster than the real cadence (pulses/hour <= runs/hour)", () => {
    for (const rph of [1, 5, 12, 60, 120, 600, 1200, 3600, 100000]) {
      const dur = pulseDurationSeconds(rph);
      const pulsesPerHour = 3600 / dur;
      expect(pulsesPerHour).toBeLessThanOrEqual(rph + 1e-9);
    }
  });

  test("floors at ORB_MIN_SECONDS so a huge burst never strobes", () => {
    expect(pulseDurationSeconds(1_000_000)).toBe(ORB_MIN_SECONDS);
  });

  test("more activity is faster-or-equal (monotonic non-increasing)", () => {
    let prev = Infinity;
    for (const rph of [1, 10, 100, 1000, 10000]) {
      const dur = pulseDurationSeconds(rph);
      expect(dur).toBeLessThanOrEqual(prev);
      prev = dur;
    }
  });
});

describe("coverageWins", () => {
  const S = (o: Record<string, EvidenceStatus>) => o;

  test("fail -> pass is a win", () => {
    expect(coverageWins(S({ a: "fail" }), S({ a: "pass" }))).toEqual(["a"]);
  });

  test("stale -> pass is a win", () => {
    expect(coverageWins(S({ a: "stale" }), S({ a: "pass" }))).toEqual(["a"]);
  });

  test("skip -> pass never celebrates", () => {
    expect(coverageWins(S({ a: "skip" }), S({ a: "pass" }))).toEqual([]);
  });

  test("already-green (pass -> pass) never glows", () => {
    expect(coverageWins(S({ a: "pass" }), S({ a: "pass" }))).toEqual([]);
  });

  test("first observation (no prior status) never celebrates", () => {
    expect(coverageWins(S({}), S({ a: "pass" }))).toEqual([]);
  });

  test("returns every winning key, ignores non-wins", () => {
    const prev = S({ a: "fail", b: "pass", c: "stale", d: "skip" });
    const next = S({ a: "pass", b: "pass", c: "pass", d: "pass" });
    expect(coverageWins(prev, next).sort()).toEqual(["a", "c"]);
  });
});

describe("justCompleted", () => {
  test("in-flight -> gone is completion", () => {
    expect(justCompleted({ agent: "x" }, null)).toBe(true);
  });
  test("no run stays no run", () => {
    expect(justCompleted(null, null)).toBe(false);
  });
  test("run starting is not completion", () => {
    expect(justCompleted(null, { agent: "x" })).toBe(false);
  });
  test("still running is not completion", () => {
    expect(justCompleted({ agent: "x" }, { agent: "x" })).toBe(false);
  });
});
