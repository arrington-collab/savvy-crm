import { describe, it, expect } from "vitest";
import { makeFakeDocuseal } from "./docuseal";

describe("makeFakeDocuseal", () => {
  it("creates a submission and parses a completed event", async () => {
    const ds = makeFakeDocuseal();
    const { submissionId, signUrl } = await ds.createSubmission({ estimateId: "e1", signerEmail: "x@y.com", total: 500000 });
    expect(submissionId).toMatch(/^ds_sub_/);
    expect(signUrl).toContain(submissionId);
    const ev = ds.parseEvent({ event_type: "form.completed", data: { submission_id: submissionId } });
    expect(ev).toEqual({ submissionId, status: "completed" });
  });

  it("returns null for a payload without a submission id, 'other' for non-completed", () => {
    const ds = makeFakeDocuseal();
    expect(ds.parseEvent({ event_type: "form.completed", data: {} })).toBeNull();
    expect(ds.parseEvent({ event_type: "form.viewed", data: { submission_id: "x" } })).toEqual({ submissionId: "x", status: "other" });
  });
});
