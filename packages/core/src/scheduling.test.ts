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
