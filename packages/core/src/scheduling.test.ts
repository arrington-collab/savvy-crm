import { test, expect } from "vitest";
import { parseSchedulingConfig } from "./scheduling";

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
