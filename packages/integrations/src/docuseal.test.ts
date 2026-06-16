import { describe, it, expect, afterEach } from "vitest";
import { createHmac } from "node:crypto";
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

describe("verifyWebhook", () => {
  afterEach(() => {
    delete process.env.DOCUSEAL_WEBHOOK_SECRET;
  });

  it("allows when no secret is configured (dev/test)", () => {
    const ds = makeFakeDocuseal();
    expect(ds.verifyWebhook("{}", null)).toBe(true);
  });

  it("requires a valid HMAC signature when a secret is set", () => {
    process.env.DOCUSEAL_WEBHOOK_SECRET = "shh";
    const ds = makeFakeDocuseal();
    const body = JSON.stringify({ event_type: "form.completed", data: { submission_id: "s1" } });
    const good = createHmac("sha256", "shh").update(body).digest("hex");
    expect(ds.verifyWebhook(body, good)).toBe(true);
    expect(ds.verifyWebhook(body, "deadbeef")).toBe(false);
    expect(ds.verifyWebhook(body, null)).toBe(false);
  });
});
