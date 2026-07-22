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
  cacheControl: string;
}

/**
 * Decide the response headers for the same-origin document viewer. Pure so the security
 * decision (inline-safe allowlist → neutral octet-stream + attachment for anything else,
 * sanitized filename, always nosniff) is unit-testable without the R2/stream plumbing.
 */
/** Raster image mimes a thumbnail request may downscale (jimp can decode these).
 *  Excludes gif (animation) + svg (already forced to attachment). */
const THUMBNAILABLE = new Set(["image/png", "image/jpeg", "image/webp"]);
export function isThumbnailable(mime: string | null | undefined): boolean {
  return mime != null && THUMBNAILABLE.has(mime);
}

/** Parse a `?w=` thumbnail width, clamped to a sane [32, 1024] range. Returns
 *  null (→ serve the full original, no resize) for absent/invalid values. */
export function clampThumbWidth(raw: string | null | undefined): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return Math.min(Math.max(n, 32), 1024);
}

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
    // A document's bytes are immutable — markup/edits create a NEW document with a
    // new id/URL — so the browser may cache aggressively. `private` keeps it out of
    // shared/CDN caches (tenant-safe). This is what makes thumbnails + gallery
    // re-views instant instead of re-downloading the full-res original every time.
    cacheControl: "private, max-age=31536000, immutable",
  };
}
