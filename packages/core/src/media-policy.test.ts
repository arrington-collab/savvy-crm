import { describe, it, expect } from "vitest";
import { validateUpload, MAX_UPLOAD_BYTES, PARSEABLE_KINDS } from "./media-policy";

describe("validateUpload", () => {
  it("accepts a PDF insurance_estimate under the cap", () => {
    expect(validateUpload({ kind: "insurance_estimate", mime: "application/pdf", sizeBytes: 1_000 }))
      .toEqual({ ok: true });
  });

  it("accepts an image for a photo kind", () => {
    expect(validateUpload({ kind: "photo", mime: "image/jpeg", sizeBytes: 1_000 }))
      .toEqual({ ok: true });
  });

  it("rejects a file over the 25MB cap", () => {
    expect(validateUpload({ kind: "photo", mime: "image/jpeg", sizeBytes: MAX_UPLOAD_BYTES + 1 }))
      .toEqual({ ok: false, error: "too_large" });
  });

  it("rejects a disallowed mime type", () => {
    expect(validateUpload({ kind: "other", mime: "application/zip", sizeBytes: 1_000 }))
      .toEqual({ ok: false, error: "mime_not_allowed" });
  });

  it("rejects a non-PDF upload for a parseable kind", () => {
    expect(validateUpload({ kind: "measurement_report", mime: "image/jpeg", sizeBytes: 1_000 }))
      .toEqual({ ok: false, error: "typed_requires_pdf" });
    expect(PARSEABLE_KINDS).toContain("measurement_report");
  });
});
