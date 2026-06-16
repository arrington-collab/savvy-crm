import { describe, it, expect, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { makeFakeDocuseal } from "./docuseal";

describe("makeFakeDocuseal", () => {
  it("creates an estimate submission and parses a completed event", async () => {
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

  it("creates a closeout submission (lien waiver / cert) and records the call", async () => {
    const ds = makeFakeDocuseal();
    const r = await ds.createClosoutSubmission({
      templateId: "tpl_1",
      signer: { name: "Jane", email: "jane@x.com" },
      fields: [{ name: "customer_name", default_value: "Jane" }],
      metadata: { tenantId: "t1", jobId: "j1", docType: "cert" },
    });
    expect(r.submissionId).toMatch(/^ds_sub_/);
    expect(r.signingUrl).toContain(r.submissionId);
    expect(ds.calls).toContain(r.submissionId);
  });

  it("downloadSignedPdf returns PDF-magic bytes", async () => {
    const ds = makeFakeDocuseal();
    const { bytes, mime } = await ds.downloadSignedPdf({ submissionId: "ds_sub_x" });
    expect(mime).toBe("application/pdf");
    expect(Array.from(bytes.slice(0, 4))).toEqual([37, 80, 68, 70]); // %PDF
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

  it("fails closed when no secret is configured in production", () => {
    const prev = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      const ds = makeFakeDocuseal();
      expect(ds.verifyWebhook("{}", null)).toBe(false);
    } finally {
      process.env.NODE_ENV = prev;
    }
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
