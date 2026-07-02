import { test, expect } from "vitest";
import { summarizeTenantCoverage, type TenantRollupLite } from "./tenant-coverage";

const rollup = (o: Partial<NonNullable<TenantRollupLite>> = {}): TenantRollupLite => ({
  fullAutoGreen: 40, totalTasks: 212, greenCount: 55, amberCount: 8, redCount: 3,
  openExceptionCount: 11, jobs30d: 20, founderMinutes30d: 120, computedAt: new Date("2026-07-02T04:00:00Z"), ...o,
});

test("no rollup yet -> hasData false, zeroed, no timestamp (pre-first-sweep state)", () => {
  const c = summarizeTenantCoverage(null);
  expect(c.hasData).toBe(false);
  expect(c.coveragePct).toBe(0);
  expect(c.totalTasks).toBe(0);
  expect(c.computedAt).toBeNull();
});

test("a rollup with no tasks is also treated as no data (avoid divide-by-zero)", () => {
  const c = summarizeTenantCoverage(rollup({ totalTasks: 0, fullAutoGreen: 0 }));
  expect(c.hasData).toBe(false);
  expect(c.coveragePct).toBe(0);
});

test("computes coverage %, and gray = total - green - amber - red", () => {
  const c = summarizeTenantCoverage(rollup());
  expect(c.hasData).toBe(true);
  expect(c.coveragePct).toBe(19); // round(40/212*100)
  expect(c.gray).toBe(212 - 55 - 8 - 3); // 146
  expect(c.green).toBe(55);
  expect(c.amber).toBe(8);
  expect(c.red).toBe(3);
  expect(c.openExceptions).toBe(11);
  expect(c.jobs30d).toBe(20);
  expect(c.founderMinutes30d).toBe(120);
  expect(c.computedAt).toEqual(new Date("2026-07-02T04:00:00Z"));
});

test("full automation reads as 100% coverage", () => {
  const c = summarizeTenantCoverage(rollup({ fullAutoGreen: 212, totalTasks: 212, greenCount: 212, amberCount: 0, redCount: 0 }));
  expect(c.coveragePct).toBe(100);
  expect(c.gray).toBe(0);
});

test("gray never goes negative even if counts exceed total (defensive)", () => {
  const c = summarizeTenantCoverage(rollup({ totalTasks: 10, greenCount: 8, amberCount: 5, redCount: 0 }));
  expect(c.gray).toBe(0);
});
