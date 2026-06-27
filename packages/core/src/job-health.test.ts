import { describe, it, expect } from "vitest";
import { deriveJobHealth, type JobHealthSignals } from "./job-health";
import { parseJobsConfig } from "./jobs-config";

const cfg = parseJobsConfig(undefined); // estimate threshold 7, retail SLA 21
const now = new Date("2026-06-27T12:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

const base: JobHealthSignals = {
  stage: "estimate",
  stageEnteredAt: daysAgo(2),
  type: "retail",
  approvedAt: null,
  hasPastDueInvoice: false,
};

describe("deriveJobHealth", () => {
  it("is healthy when within stage threshold, not past SLA, no past-due", () => {
    expect(deriveJobHealth(base, cfg, now)).toEqual({ stuck: false, late: false, reasons: [] });
  });
  it("flags stuck when days-in-stage exceeds the stage threshold", () => {
    const r = deriveJobHealth({ ...base, stageEnteredAt: daysAgo(9) }, cfg, now); // >7
    expect(r.stuck).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/stuck 9d in estimate/);
  });
  it("never flags stuck in terminal stages (no configured threshold)", () => {
    const r = deriveJobHealth({ ...base, stage: "complete", stageEnteredAt: daysAgo(99) }, cfg, now);
    expect(r.stuck).toBe(false);
  });
  it("flags late when now is past approvedAt + buildSlaDays[type]", () => {
    const r = deriveJobHealth({ ...base, approvedAt: daysAgo(30) }, cfg, now); // retail SLA 21
    expect(r.late).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/past expected completion/);
  });
  it("does not flag late by SLA when not yet approved", () => {
    expect(deriveJobHealth({ ...base, approvedAt: null }, cfg, now).late).toBe(false);
  });
  it("flags late on a past-due invoice regardless of stage/approval", () => {
    const r = deriveJobHealth({ ...base, hasPastDueInvoice: true }, cfg, now);
    expect(r.late).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/invoice past due/);
  });
  it("can be both stuck and late", () => {
    const r = deriveJobHealth({ ...base, stageEnteredAt: daysAgo(9), approvedAt: daysAgo(30) }, cfg, now);
    expect(r).toMatchObject({ stuck: true, late: true });
  });
});
