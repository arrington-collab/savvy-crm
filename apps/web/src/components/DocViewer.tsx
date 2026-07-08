"use client";
import { useEffect } from "react";

export interface ViewerDoc {
  id: string;
  filename: string | null;
  mime: string | null;
  uploaderName?: string | null;
  createdAt: string | Date;
}

function fmt(d: string | Date): string {
  return new Date(d).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Modal document viewer. PDFs render in a same-origin iframe, images inline, anything else
 * offers a download. The view URL is our proxy route (/api/documents/{id}/view) — no R2 key
 * or PII in the browser. Header shows filename · uploader · date. Escape / backdrop close.
 */
export function DocViewer({ doc, onClose }: { doc: ViewerDoc | null; onClose: () => void }) {
  useEffect(() => {
    if (!doc) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doc, onClose]);

  if (!doc) return null;
  const src = `/api/documents/${doc.id}/view`;
  const isPdf = doc.mime === "application/pdf";
  const isImage = (doc.mime ?? "").startsWith("image/");

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Document ${doc.filename ?? ""}`}
      onClick={onClose}
      className="fixed inset-0 z-50 flex flex-col"
      style={{ background: "color-mix(in srgb, var(--surface) 80%, transparent)" }}
      data-testid="doc-viewer"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="mx-auto my-6 flex h-[90vh] w-[min(1000px,94vw)] flex-col overflow-hidden rounded-lg border shadow-lg"
        style={{ borderColor: "var(--border)", background: "var(--surface)" }}
      >
        <div className="flex items-center justify-between gap-3 border-b px-4 py-2" style={{ borderColor: "var(--border)" }}>
          <div className="min-w-0">
            <div className="truncate font-medium" data-testid="doc-viewer-filename">{doc.filename ?? "(unnamed)"}</div>
            <div className="mono text-xs" style={{ color: "var(--text-faint)" }}>
              {doc.uploaderName ?? "system"} · {fmt(doc.createdAt)}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <a href={`${src}?download=1`} className="rounded border px-2 py-1 text-sm" style={{ borderColor: "var(--border)" }}>Download</a>
            <button onClick={onClose} aria-label="Close" className="rounded border px-2 py-1 text-sm" style={{ borderColor: "var(--border)" }}>✕</button>
          </div>
        </div>
        <div className="flex-1 overflow-auto" style={{ background: "var(--surface-muted)" }}>
          {isPdf ? (
            <iframe src={src} title={doc.filename ?? "document"} className="h-full w-full" style={{ border: "none" }} />
          ) : isImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={src} alt={doc.filename ?? "document"} className="mx-auto max-h-full max-w-full object-contain" />
          ) : (
            <div className="flex h-full items-center justify-center">
              <a href={`${src}?download=1`} className="rounded border px-3 py-2 text-sm" style={{ borderColor: "var(--border)" }}>
                Download {doc.filename ?? "file"}
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
