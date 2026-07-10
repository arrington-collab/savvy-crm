// Types safe to render inline on the app origin. Everything else (notably text/html and
// image/svg+xml, which can script) is forced to a neutral octet-stream attachment — so a
// stored file can never execute in the app's origin. Defense-in-depth beyond upload-time
// MIME validation.
const INLINE_SAFE = new Set(["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"]);

export interface DocumentViewHeaders {
  contentType: string;
  disposition: string;
  noSniff: true;
  inline: boolean;
}

/**
 * Decide the response headers for the same-origin document viewer. Pure so the security
 * decision (inline-safe allowlist → neutral octet-stream + attachment for anything else,
 * sanitized filename, always nosniff) is unit-testable without the R2/stream plumbing.
 */
export function buildDocumentViewHeaders(input: {
  mime: string | null;
  filename: string | null;
  download: boolean;
}): DocumentViewHeaders {
  const allowedInline = input.mime != null && INLINE_SAFE.has(input.mime);
  const inline = allowedInline && !input.download;
  const safe = (input.filename ?? "document").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "document";
  return {
    contentType: allowedInline ? input.mime! : "application/octet-stream",
    disposition: `${inline ? "inline" : "attachment"}; filename="${safe}"`,
    noSniff: true,
    inline,
  };
}
