/** #341 media policy — shared upload validation (pure, no DB). */

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB/doc

export const ALLOWED_UPLOAD_MIME = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
] as const;

/** Typed lead-document kinds that feed the parse pipeline (6b/6c). PDF-only. */
export const PARSEABLE_KINDS = ["insurance_estimate", "measurement_report"] as const;
export type ParseableKind = (typeof PARSEABLE_KINDS)[number];

export type UploadValidationError = "too_large" | "mime_not_allowed" | "typed_requires_pdf";

export function validateUpload(input: {
  kind: string;
  mime: string;
  sizeBytes: number;
}): { ok: true } | { ok: false; error: UploadValidationError } {
  if (input.sizeBytes > MAX_UPLOAD_BYTES) return { ok: false, error: "too_large" };
  if (!(ALLOWED_UPLOAD_MIME as readonly string[]).includes(input.mime)) {
    return { ok: false, error: "mime_not_allowed" };
  }
  if ((PARSEABLE_KINDS as readonly string[]).includes(input.kind) && input.mime !== "application/pdf") {
    return { ok: false, error: "typed_requires_pdf" };
  }
  return { ok: true };
}
