import { test, expect } from "vitest";
import { jobTaskApplies } from "./job-task";

test("an unrestricted task applies to every job type", () => {
  expect(jobTaskApplies({}, "retail")).toBe(true);
  expect(jobTaskApplies({ job_types: [] }, "insurance")).toBe(true);
});

test("a job-type-restricted task applies only to the listed types", () => {
  expect(jobTaskApplies({ job_types: ["insurance"] }, "insurance")).toBe(true);
  expect(jobTaskApplies({ job_types: ["insurance"] }, "retail")).toBe(false);
  expect(jobTaskApplies({ job_types: ["retail", "repair"] }, "repair")).toBe(true);
  expect(jobTaskApplies({ job_types: ["retail", "repair"] }, "commercial")).toBe(false);
});
