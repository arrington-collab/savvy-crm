import { test, expect } from "vitest";
import { sumFounderMinutes, type FounderMinuteItem } from "./founder-minutes";

const at = (iso: string) => new Date(iso);
const item = (o: Partial<FounderMinuteItem>): FounderMinuteItem => ({ firstViewedAt: null, resolvedAt: null, ...o });

test("no items -> 0", () => {
  expect(sumFounderMinutes([])).toBe(0);
});

test("counts minutes between first view and resolution", () => {
  expect(sumFounderMinutes([item({ firstViewedAt: at("2026-07-02T04:00:00Z"), resolvedAt: at("2026-07-02T04:10:00Z") })])).toBe(10);
});

test("caps a single item at 30 minutes", () => {
  expect(sumFounderMinutes([item({ firstViewedAt: at("2026-07-02T04:00:00Z"), resolvedAt: at("2026-07-02T06:00:00Z") })])).toBe(30);
});

test("ignores items never opened (no first_viewed_at) or not resolved", () => {
  expect(sumFounderMinutes([
    item({ firstViewedAt: null, resolvedAt: at("2026-07-02T04:10:00Z") }),
    item({ firstViewedAt: at("2026-07-02T04:00:00Z"), resolvedAt: null }),
  ])).toBe(0);
});

test("ignores negative durations (resolved before viewed)", () => {
  expect(sumFounderMinutes([item({ firstViewedAt: at("2026-07-02T04:10:00Z"), resolvedAt: at("2026-07-02T04:00:00Z") })])).toBe(0);
});

test("sums across items, each capped independently", () => {
  expect(sumFounderMinutes([
    item({ firstViewedAt: at("2026-07-02T04:00:00Z"), resolvedAt: at("2026-07-02T04:10:00Z") }), // 10
    item({ firstViewedAt: at("2026-07-02T04:00:00Z"), resolvedAt: at("2026-07-02T05:00:00Z") }), // 60 -> 30
  ])).toBe(40);
});
