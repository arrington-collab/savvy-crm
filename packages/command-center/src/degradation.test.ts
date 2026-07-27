import { it, expect } from "vitest";
import { ok, pending, type MetricValue } from "./degradation";

it("ok() wraps a computed number", () => {
  const v: MetricValue = ok(42);
  expect(v).toEqual({ status: "ok", value: 42 });
});

it("pending() carries a human reason instead of a fabricated number", () => {
  const v: MetricValue = pending("awaiting crew app");
  expect(v).toEqual({ status: "pending", reason: "awaiting crew app" });
});

it("ok and pending are structurally distinguishable by status", () => {
  const values: MetricValue[] = [ok(0), pending("no cost data")];
  expect(values[0]!.status).toBe("ok");
  expect(values[1]!.status).toBe("pending");
  // ok(0) must remain a real zero, never conflated with "unknown"
  if (values[0]!.status === "ok") expect(values[0]!.value).toBe(0);
});
