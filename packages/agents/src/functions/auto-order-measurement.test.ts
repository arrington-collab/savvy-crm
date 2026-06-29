import { test, expect } from "vitest";
import { shouldAutoOrderMeasurement } from "./auto-order-measurement";

const base = { enabled: true, apptType: "inspection", apptStatus: "scheduled", hasMeasurement: false };

test("orders when enabled + scheduled inspection + no measurement yet", () => {
  expect(shouldAutoOrderMeasurement(base)).toBe(true);
});

test("skips when the tenant toggle is off", () => {
  expect(shouldAutoOrderMeasurement({ ...base, enabled: false })).toBe(false);
});

test("skips non-inspection appointment types", () => {
  for (const apptType of ["cm", "crew", "adjuster"]) {
    expect(shouldAutoOrderMeasurement({ ...base, apptType })).toBe(false);
  }
});

test("skips when the appointment is not scheduled", () => {
  expect(shouldAutoOrderMeasurement({ ...base, apptStatus: "canceled" })).toBe(false);
});

test("skips when the property already has a measurement (no re-order)", () => {
  expect(shouldAutoOrderMeasurement({ ...base, hasMeasurement: true })).toBe(false);
});
