import { test, expect } from "vitest";
import { makeFakeDocuseal } from "./docuseal";

test("fake createSubmission returns a submissionId + signingUrl and records the call", async () => {
  const d = makeFakeDocuseal();
  const r = await d.createSubmission({
    templateId: "tpl_1",
    signer: { name: "Jane", email: "jane@x.com" },
    fields: [{ name: "customer_name", default_value: "Jane" }],
    metadata: { tenantId: "t1", jobId: "j1", docType: "cert" },
  });
  expect(r.submissionId).toMatch(/^sub_fake_/);
  expect(r.signingUrl).toContain(r.submissionId);
  expect(d.calls).toContainEqual({ op: "create" });
});

test("fake verifyWebhook parses a well-formed body and rejects junk", () => {
  const d = makeFakeDocuseal();
  expect(d.verifyWebhook(JSON.stringify({ submissionId: "sub_fake_1", status: "completed" }), null))
    .toEqual({ submissionId: "sub_fake_1", status: "completed" });
  expect(d.verifyWebhook("not json", null)).toBeNull();
  expect(d.verifyWebhook(JSON.stringify({ status: "completed" }), null)).toBeNull();
});

test("fake downloadSignedPdf returns PDF-magic bytes", async () => {
  const d = makeFakeDocuseal();
  const { bytes, mime } = await d.downloadSignedPdf({ submissionId: "sub_fake_1" });
  expect(mime).toBe("application/pdf");
  expect(Array.from(bytes.slice(0, 4))).toEqual([37, 80, 68, 70]); // %PDF
});
