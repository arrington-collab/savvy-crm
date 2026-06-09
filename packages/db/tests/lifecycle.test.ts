import { describe, it, expect } from "vitest";
import { TASK_TEMPLATES, PHASE_TO_STAGE } from "../src/seed-data/templates";
import { JOB_STAGE } from "@savvy/core";

describe("task lifecycle templates", () => {
  it("has all 212 tasks", () => {
    expect(TASK_TEMPLATES.length).toBe(212);
  });
  it("every phase maps to a stage or ORG", () => {
    const phases = new Set(TASK_TEMPLATES.map((t) => t.phase));
    for (const p of phases) expect(PHASE_TO_STAGE[p]).toBeDefined();
  });
  it("non-org tasks have a valid job_stage; org tasks have stage null", () => {
    for (const t of TASK_TEMPLATES) {
      if (t.orgLevel) expect(t.stage).toBeNull();
      else expect(JOB_STAGE).toContain(t.stage);
    }
  });
  it("keys are unique and stable", () => {
    const keys = TASK_TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it("All-type tasks expand to 4 job types", () => {
    const allTask = TASK_TEMPLATES.find((t) => t.jobTypes.length === 4);
    expect(allTask).toBeTruthy();
  });
});
