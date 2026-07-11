import { describe, it, expect } from "vitest";
import { summarizeMinutesSaved, describeOdometer, MINUTES_SAVED } from "./minutes-saved";

const ok = (taskKey: string | null) => ({ taskKey, status: "ok" });

describe("summarizeMinutesSaved", () => {
  it("empty input → zero minutes, no lines", () => {
    expect(summarizeMinutesSaved([])).toEqual({ totalMinutes: 0, lines: [] });
  });

  it("sums minutes for known task keys over ok runs, lines sorted by subtotal desc", () => {
    const r = summarizeMinutesSaved([ok("estimate.generate"), ok("estimate.generate"), ok("ops.digest")]);
    expect(r.totalMinutes).toBe(50); // 2×20 + 1×10
    expect(r.lines.map((l) => l.taskKey)).toEqual(["estimate.generate", "ops.digest"]);
    expect(r.lines[0]).toMatchObject({ count: 2, minutesEach: 20, subtotal: 40 });
    expect(r.lines[0].verb.length).toBeGreaterThan(0);
  });

  it("unknown task key contributes 0 minutes, never a guess", () => {
    const r = summarizeMinutesSaved([ok("lead.qualify"), ok("crew.checkin"), ok(null)]);
    expect(r.totalMinutes).toBe(0);
    expect(r.lines).toEqual([]);
  });

  it("credits only ok runs — skipped/error/running save nothing", () => {
    const r = summarizeMinutesSaved([
      { taskKey: "ops.digest", status: "skipped" },
      { taskKey: "estimate.generate", status: "error" },
      { taskKey: "enrich.property", status: "running" },
    ]);
    expect(r.totalMinutes).toBe(0);
    expect(r.lines).toEqual([]);
  });

  it("explicitly excluded internal work (0 in the map) never credits", () => {
    expect(MINUTES_SAVED["ops.health_sweep"] ?? 0).toBe(0);
    const r = summarizeMinutesSaved([ok("ops.health_sweep")]);
    expect(r.totalMinutes).toBe(0);
  });

  it("credits the real runtime estimate taskKey (estimating-049)", () => {
    const r = summarizeMinutesSaved([ok("estimating-049")]);
    expect(r.totalMinutes).toBe(20);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({ taskKey: "estimating-049", count: 1, minutesEach: 20, subtotal: 20 });
  });
});

describe("describeOdometer", () => {
  it("zero actions → quiet mode (no count-up)", () => {
    const v = describeOdometer(0, { totalMinutes: 0, lines: [] });
    expect(v.mode).toBe("quiet");
  });

  it("any actions → counting mode, carries minutes and lines through", () => {
    const saved = summarizeMinutesSaved([ok("ops.digest")]);
    const v = describeOdometer(3, saved);
    expect(v.mode).toBe("counting");
    expect(v.actions).toBe(3);
    expect(v.minutes).toBe(10);
    expect(v.lines).toHaveLength(1);
  });

  it("clamps negative actions to 0/quiet", () => {
    expect(describeOdometer(-5, { totalMinutes: 0, lines: [] }).mode).toBe("quiet");
    expect(describeOdometer(-5, { totalMinutes: 0, lines: [] }).actions).toBe(0);
  });
});
