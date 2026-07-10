import { describe, it, expect } from "vitest";
import { buildDocumentViewHeaders } from "./document-view";

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
});
