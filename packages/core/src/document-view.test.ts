import { describe, it, expect } from "vitest";
import { buildDocumentViewHeaders, clampThumbWidth, isThumbnailable, photoVariantKey, PHOTO_VARIANT_WIDTHS } from "./document-view";

describe("buildDocumentViewHeaders", () => {
  it("serves an allowlisted PDF inline with its own content-type + nosniff", () => {
    const h = buildDocumentViewHeaders({ mime: "application/pdf", filename: "estimate.pdf", download: false });
    expect(h.contentType).toBe("application/pdf");
    expect(h.disposition).toBe('inline; filename="estimate.pdf"');
    expect(h.noSniff).toBe(true);
  });

  it("RED PATH: a scriptable/unknown type (text/html) is forced to a neutral octet-stream ATTACHMENT — never inline", () => {
    const h = buildDocumentViewHeaders({ mime: "text/html", filename: "x.html", download: false });
    expect(h.contentType).toBe("application/octet-stream");
    expect(h.disposition.startsWith("attachment;")).toBe(true);
  });

  it("RED PATH: image/svg+xml (can script) is also forced to attachment octet-stream", () => {
    const h = buildDocumentViewHeaders({ mime: "image/svg+xml", filename: "x.svg", download: false });
    expect(h.contentType).toBe("application/octet-stream");
    expect(h.disposition.startsWith("attachment;")).toBe(true);
  });

  it("?download=1 forces attachment even for an inline-safe PDF", () => {
    const h = buildDocumentViewHeaders({ mime: "application/pdf", filename: "estimate.pdf", download: true });
    expect(h.disposition).toBe('attachment; filename="estimate.pdf"');
  });

  it("sanitizes the filename (no PII/paths leak into the header)", () => {
    const h = buildDocumentViewHeaders({ mime: "application/pdf", filename: '../../etc/pa ss wd;"evil".pdf', download: false });
    expect(h.disposition).not.toContain("/");
    expect(h.disposition).not.toContain('"evil"');
    expect(h.disposition).toMatch(/^inline; filename="[a-zA-Z0-9._-]+"$/);
  });

  it("null mime → octet-stream attachment; null filename → a safe default", () => {
    const h = buildDocumentViewHeaders({ mime: null, filename: null, download: false });
    expect(h.contentType).toBe("application/octet-stream");
    expect(h.disposition).toBe('attachment; filename="document"');
  });

  it("marks the object immutable + privately cacheable (a document's bytes never change)", () => {
    const h = buildDocumentViewHeaders({ mime: "image/jpeg", filename: "roof.jpg", download: false });
    // private → browser-only (never a shared/CDN cache, tenant-safe); immutable +
    // long max-age → thumbnails & gallery re-views come from cache, not a re-download.
    expect(h.cacheControl).toBe("private, max-age=31536000, immutable");
  });
});

describe("clampThumbWidth", () => {
  it("parses a valid width and clamps to [32, 1024]", () => {
    expect(clampThumbWidth("192")).toBe(192);
    expect(clampThumbWidth("10")).toBe(32);    // below floor
    expect(clampThumbWidth("5000")).toBe(1024); // above ceiling
  });
  it("returns null for absent/invalid widths (→ serve the original, no resize)", () => {
    expect(clampThumbWidth(null)).toBeNull();
    expect(clampThumbWidth("")).toBeNull();
    expect(clampThumbWidth("abc")).toBeNull();
    expect(clampThumbWidth("-4")).toBeNull();
  });
});

describe("isThumbnailable", () => {
  it("true only for raster images jimp can resize", () => {
    expect(isThumbnailable("image/jpeg")).toBe(true);
    expect(isThumbnailable("image/png")).toBe(true);
    expect(isThumbnailable("image/webp")).toBe(true);
    expect(isThumbnailable("application/pdf")).toBe(false);
    expect(isThumbnailable("image/svg+xml")).toBe(false);
    expect(isThumbnailable(null)).toBe(false);
  });
});

describe("photo variants (pre-generation)", () => {
  it("PHOTO_VARIANT_WIDTHS = [192, 1600]", () => {
    expect([...PHOTO_VARIANT_WIDTHS]).toEqual([192, 1600]);
  });
  it("photoVariantKey derives a deterministic per-width key", () => {
    expect(photoVariantKey("acculynx/t/j/photo/f_a.jpg", 192)).toBe("acculynx/t/j/photo/f_a.jpg__w192.jpg");
    expect(photoVariantKey("k", 1600)).toBe("k__w1600.jpg");
  });
});
