import { describe, it, expect } from "vitest";
import { shouldAutoOrderMeasurement } from "./auto-order-measurement";

describe("Roofr auto-order suppression (Slice 6b lock)", () => {
  const base = { enabled: true, apptType: "inspection", apptStatus: "scheduled" };

  it("orders when the property has no measurement", () => {
    expect(shouldAutoOrderMeasurement({ ...base, hasMeasurement: false })).toBe(true);
  });

  it("does NOT order once the property has a measurement (e.g. an uploaded report)", () => {
    expect(shouldAutoOrderMeasurement({ ...base, hasMeasurement: true })).toBe(false);
  });
});
