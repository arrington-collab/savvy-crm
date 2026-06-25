import { test, expect } from "vitest";
import { parseSchedulingConfig, haversineMeters, computeOpenSlots } from "./scheduling";

test("empty config yields safe defaults", () => {
  const c = parseSchedulingConfig(undefined);
  expect(c.slotGranularityMin).toBe(30);
  expect(c.bookingHorizonDays).toBe(14);
  expect(c.hours.mon).toEqual([8, 17]);
  expect(c.hours.sun).toEqual([]);
  expect(c.types.inspection).toEqual({ durationMin: 60, bufferMin: 30 });
  expect(c.reminders).toEqual([
    { offsetH: 24, channel: "sms" },
    { offsetH: 2, channel: "sms" },
  ]);
});

test("partial config merges over defaults", () => {
  const c = parseSchedulingConfig({ slotGranularityMin: 15, hours: { sat: [9, 12] } });
  expect(c.slotGranularityMin).toBe(15);
  expect(c.hours.sat).toEqual([9, 12]);
  expect(c.hours.mon).toEqual([8, 17]); // default kept
});

test("haversine ~ known distance", () => {
  // ~1.11 km between 0,0 and 0.01,0
  const d = haversineMeters({ lat: 0, lng: 0 }, { lat: 0.01, lng: 0 });
  expect(d).toBeGreaterThan(1090);
  expect(d).toBeLessThan(1130);
});

// ── computeOpenSlots tests ──────────────────────────────────────────────────

const cfg = parseSchedulingConfig({
  hours: { mon: [8, 10], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
  slotGranularityMin: 60,
  bookingHorizonDays: 1,
});
// A Monday 8am UTC reference.
const mon = new Date("2026-06-15T00:00:00Z"); // 2026-06-15 is a Monday

test("generates slots inside working hours, excludes past", () => {
  const slots = computeOpenSlots({
    config: cfg, type: "inspection",
    existingAppts: [], fromDate: mon, now: mon,
  });
  // inspection 60m + 30m buffer; 8-10 window -> only 8:00 fits (ends 9:00, +buffer 9:30 < 10) ; 9:00 ends 10:00 +buffer exceeds 10
  expect(slots.length).toBe(1);
  expect(slots[0]!.startsAt.toISOString()).toBe("2026-06-15T08:00:00.000Z");
});

test("removes slots overlapping an existing appt (incl. buffer)", () => {
  const slots = computeOpenSlots({
    config: cfg, type: "inspection",
    existingAppts: [{ startsAt: new Date("2026-06-15T08:00:00Z"), endsAt: new Date("2026-06-15T09:00:00Z") }],
    fromDate: mon, now: mon,
  });
  expect(slots.length).toBe(0);
});

test("proximity scoring ranks near-cluster slots higher", () => {
  const wideCfg = parseSchedulingConfig({
    hours: { mon: [8, 12] }, slotGranularityMin: 60, bookingHorizonDays: 1,
  });
  const slots = computeOpenSlots({
    config: wideCfg, type: "cm", // 60m + 15m buffer
    existingAppts: [{ startsAt: new Date("2026-06-15T11:00:00Z"), endsAt: new Date("2026-06-15T11:30:00Z"), lat: 33.4, lng: -112.0 }],
    fromDate: mon, now: mon,
    clusterAround: { lat: 33.4, lng: -112.0 },
  });
  // All returned slots carry a score; highest score first.
  expect(slots.length).toBeGreaterThan(0);
  for (let i = 1; i < slots.length; i++) expect(slots[i - 1]!.score).toBeGreaterThanOrEqual(slots[i]!.score);
});

import { describe, it } from "vitest";
import { rankSlots } from "./scheduling";
import type { Slot } from "./scheduling";

const mk = (iso: string, score = 0): Slot => ({ startsAt: new Date(iso), endsAt: new Date(iso), score });

describe("parseSchedulingConfig drive-time defaults", () => {
  it("defaults driveTime weights and leaves office undefined", () => {
    const c = parseSchedulingConfig({});
    expect(c.driveTime).toEqual({ wSoon: 0.5, wDrive: 0.3, wCluster: 0.2, driveHalfMin: 20 });
    expect(c.office).toBeUndefined();
  });
  it("accepts a configured office and weight overrides", () => {
    const c = parseSchedulingConfig({ office: { lat: 33.4, lng: -111.9 }, driveTime: { wDrive: 0.6 } });
    expect(c.office).toEqual({ lat: 33.4, lng: -111.9 });
    expect(c.driveTime.wDrive).toBe(0.6);
    expect(c.driveTime.driveHalfMin).toBe(20); // untouched default
  });
});

describe("rankSlots", () => {
  const weights = { wSoon: 0.5, wDrive: 0.3, wCluster: 0.2, driveHalfMin: 20 };
  const a = mk("2026-07-01T15:00:00Z");
  const b = mk("2026-07-01T17:00:00Z");

  it("prefers the soonest slot when drive time is equal", () => {
    const r = rankSlots({ slots: [b, a], driveMinutesBySlotIndex: [10, 10], weights });
    expect(r[0]!.startsAt.toISOString()).toBe("2026-07-01T15:00:00.000Z");
  });
  it("prefers the nearer slot when start times are equal", () => {
    const a2 = mk("2026-07-01T15:00:00Z");
    const r = rankSlots({ slots: [a, a2], driveMinutesBySlotIndex: [40, 5], weights });
    expect(r[0]!.driveMinutes).toBe(5);
  });
  it("ranks on soon+cluster only when drive time is unknown (null)", () => {
    const near = mk("2026-07-01T17:00:00Z", 1); // later but high cluster score
    const r = rankSlots({ slots: [a, near], driveMinutesBySlotIndex: [null, null], weights });
    expect(r[0]!.driveMinutes).toBeNull();
    expect(r).toHaveLength(2);
  });
  it("attaches driveMinutes to each ranked slot", () => {
    const r = rankSlots({ slots: [a], driveMinutesBySlotIndex: [12], weights });
    expect(r[0]!.driveMinutes).toBe(12);
  });
  it("returns [] for no slots", () => {
    expect(rankSlots({ slots: [], driveMinutesBySlotIndex: [], weights })).toEqual([]);
  });
});
