import { describe, it, expect } from "vitest";
import { pipelineGrossAsOf, type AsOfJob, type AsOfEvent } from "./pipeline-asof";

const D = (s: string) => new Date(s);
const asOf = D("2026-06-15T00:00:00Z");

describe("pipelineGrossAsOf", () => {
  it("excludes jobs not yet created at asOf", () => {
    const jobs: AsOfJob[] = [{ id: "j1", valueEstimate: 1000, openedAt: D("2026-06-20T00:00:00Z") }];
    expect(pipelineGrossAsOf(jobs, [], asOf)).toEqual({});
  });
  it("treats a job with no event before asOf as stage 'lead'", () => {
    const jobs: AsOfJob[] = [{ id: "j1", valueEstimate: 1000, openedAt: D("2026-06-01T00:00:00Z") }];
    const events: AsOfEvent[] = [{ jobId: "j1", toStage: "approved", enteredAt: D("2026-06-20T00:00:00Z") }]; // after asOf
    expect(pipelineGrossAsOf(jobs, events, asOf)).toEqual({ lead: 1000 });
  });
  it("uses the latest event at/before asOf to place the job", () => {
    const jobs: AsOfJob[] = [{ id: "j1", valueEstimate: 5000, openedAt: D("2026-06-01T00:00:00Z") }];
    const events: AsOfEvent[] = [
      { jobId: "j1", toStage: "inspected", enteredAt: D("2026-06-05T00:00:00Z") },
      { jobId: "j1", toStage: "estimate", enteredAt: D("2026-06-10T00:00:00Z") },
      { jobId: "j1", toStage: "approved", enteredAt: D("2026-06-20T00:00:00Z") }, // after asOf, ignored
    ];
    expect(pipelineGrossAsOf(jobs, events, asOf)).toEqual({ estimate: 5000 });
  });
  it("excludes jobs that were terminal as of asOf", () => {
    const jobs: AsOfJob[] = [{ id: "j1", valueEstimate: 5000, openedAt: D("2026-06-01T00:00:00Z") }];
    const events: AsOfEvent[] = [{ jobId: "j1", toStage: "complete", enteredAt: D("2026-06-10T00:00:00Z") }];
    expect(pipelineGrossAsOf(jobs, events, asOf)).toEqual({});
  });
  it("sums multiple jobs into their as-of stages, null value as 0", () => {
    const jobs: AsOfJob[] = [
      { id: "a", valueEstimate: 1000, openedAt: D("2026-06-01T00:00:00Z") },
      { id: "b", valueEstimate: null, openedAt: D("2026-06-01T00:00:00Z") },
      { id: "c", valueEstimate: 2000, openedAt: D("2026-06-01T00:00:00Z") },
    ];
    const events: AsOfEvent[] = [
      { jobId: "a", toStage: "estimate", enteredAt: D("2026-06-05T00:00:00Z") },
      { jobId: "c", toStage: "estimate", enteredAt: D("2026-06-05T00:00:00Z") },
    ];
    expect(pipelineGrossAsOf(jobs, events, asOf)).toEqual({ estimate: 3000, lead: 0 });
  });
});
