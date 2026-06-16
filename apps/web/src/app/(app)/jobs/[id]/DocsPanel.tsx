"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { presignDocumentUpload, presignDocumentView, recordDocument } from "@/lib/document-actions";
import { Button } from "@/components/ui/button";

// Mirrors the columns selected in page.tsx
export interface DocRow {
  id: string;
  kind: string;
  label: string | null;
  filename: string | null;
  mime: string | null;
  createdAt: string;
}

interface Props {
  jobId: string;
  documents: DocRow[];
  requiredPhotos: string[];
}

const KIND_OPTIONS = ["photo", "measurement", "contract", "evidence", "other"] as const;
type DocKind = (typeof KIND_OPTIONS)[number];

// ─── DocThumb ────────────────────────────────────────────────────────────────
// Resolves a presigned URL on mount and renders an <img> or a fallback.
function DocThumb({ docId, filename }: { docId: string; filename: string | null }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    presignDocumentView(docId).then((res) => {
      if (cancelled) return;
      if ("ok" in res) setSrc(res.url);
      else setFailed(true);
    });
    return () => { cancelled = true; };
  }, [docId]);

  if (failed) {
    return (
      <div className="flex h-24 w-24 items-center justify-center rounded-md border border-border bg-muted text-xs text-muted-foreground">
        unavailable
      </div>
    );
  }
  if (!src) {
    return (
      <div className="h-24 w-24 animate-pulse rounded-md bg-muted" aria-label="Loading photo" />
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={filename ?? "document photo"}
      className="h-24 w-24 rounded-md border border-border object-cover"
    />
  );
}

// ─── DocFile ─────────────────────────────────────────────────────────────────
// Non-photo doc — shows filename + "View" button that presigns on click.
function DocFile({ docId, filename }: { docId: string; filename: string | null }) {
  const [loading, setLoading] = useState(false);

  async function handleView() {
    setLoading(true);
    const res = await presignDocumentView(docId);
    setLoading(false);
    if ("ok" in res) {
      window.open(res.url, "_blank", "noreferrer");
    } else {
      toast.error("Could not load document — storage may not be configured.");
    }
  }

  return (
    <div className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
      <span className="truncate text-muted-foreground">{filename ?? "file"}</span>
      <Button variant="outline" size="sm" onClick={handleView} disabled={loading}>
        {loading ? "Loading…" : "View"}
      </Button>
    </div>
  );
}

// ─── DocsPanel ───────────────────────────────────────────────────────────────
export function DocsPanel({ jobId, documents, requiredPhotos }: Props) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, startBusy] = useTransition();

  const [selectedLabel, setSelectedLabel] = useState<string>(requiredPhotos[0] ?? "other");
  const [selectedKind, setSelectedKind] = useState<DocKind>("photo");

  const photos = documents.filter((d) => d.kind === "photo");
  const nonPhotos = documents.filter((d) => d.kind !== "photo");

  // ── required-photo checklist ──
  const checklistItems = requiredPhotos.map((label) => {
    const present = documents.some(
      (d) => d.kind === "photo" && d.label?.toLowerCase() === label.toLowerCase(),
    );
    return { label, present };
  });

  // ── upload handler ──
  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;

    startBusy(async () => {
      try {
        const pre = await presignDocumentUpload({
          jobId,
          kind: selectedKind,
          label: selectedLabel,
          filename: f.name,
          contentType: f.type,
        });

        if (!("ok" in pre)) {
          toast.error(
            pre.error === "storage_not_configured"
              ? "Storage is not configured — set R2 env vars."
              : "Job not found.",
          );
          return;
        }

        const put = await fetch(pre.uploadUrl, {
          method: "PUT",
          body: f,
          headers: { "Content-Type": f.type },
        });
        if (!put.ok) {
          toast.error("Upload failed — please try again.");
          return;
        }

        const rec = await recordDocument({
          jobId,
          r2Key: pre.r2Key,
          kind: selectedKind,
          label: selectedLabel,
          filename: f.name,
          mime: f.type,
          sizeBytes: f.size,
        });

        if ("ok" in rec) {
          toast.success("Document saved.");
          router.refresh();
        } else {
          toast.error(`Could not save document record (${rec.error}).`);
        }
      } finally {
        // Reset file input on success or failure so stale filename is not retained
        if (fileRef.current) fileRef.current.value = "";
      }
    });
  }

  return (
    <div className="space-y-6">
      {/* ── 1. Required-photo checklist ─────────────────────────────────── */}
      {requiredPhotos.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold text-muted-foreground">
            Required photos
          </h3>
          <ul className="space-y-1" role="list">
            {checklistItems.map(({ label, present }) => (
              <li
                key={label}
                data-testid={`required-photo-${label}`}
                className="flex items-center gap-2 text-sm"
                aria-label={`${label}: ${present ? "uploaded" : "missing"}`}
              >
                <span
                  className={
                    present ? "text-green-600 dark:text-green-400" : "text-destructive"
                  }
                  aria-hidden
                >
                  {present ? "✓" : "✗"}
                </span>
                <span className={present ? "" : "text-muted-foreground"}>{label}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── 2. Photo grid ──────────────────────────────────────────────── */}
      {photos.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold text-muted-foreground">Photos</h3>
          <div className="flex flex-wrap gap-2">
            {photos.map((doc) => (
              <div key={doc.id} className="space-y-1">
                <DocThumb docId={doc.id} filename={doc.filename} />
                {doc.label && (
                  <p className="w-24 truncate text-center text-xs text-muted-foreground">
                    {doc.label}
                  </p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── 2b. Non-photo docs ──────────────────────────────────────────── */}
      {nonPhotos.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold text-muted-foreground">Documents</h3>
          <div className="space-y-2">
            {nonPhotos.map((doc) => (
              <DocFile key={doc.id} docId={doc.id} filename={doc.filename} />
            ))}
          </div>
        </section>
      )}

      {documents.length === 0 && requiredPhotos.length === 0 && (
        <p className="text-sm text-muted-foreground">No documents yet.</p>
      )}

      {/* ── 3. Upload control ───────────────────────────────────────────── */}
      <section className="space-y-3 rounded-md border border-border p-4">
        <h3 className="text-sm font-semibold">Upload document / photo</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {/* Label selector */}
          <div className="space-y-1">
            <label htmlFor="doc-label" className="text-xs text-muted-foreground">
              Label
            </label>
            <select
              id="doc-label"
              value={selectedLabel}
              onChange={(e) => setSelectedLabel(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
            >
              {requiredPhotos.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
              <option value="other">other</option>
            </select>
          </div>

          {/* Kind selector */}
          <div className="space-y-1">
            <label htmlFor="doc-kind" className="text-xs text-muted-foreground">
              Type
            </label>
            <select
              id="doc-kind"
              value={selectedKind}
              onChange={(e) => setSelectedKind(e.target.value as DocKind)}
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
            >
              {KIND_OPTIONS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* File input */}
        <div className="space-y-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            data-testid="doc-upload-input"
            disabled={busy}
            onChange={handleFileChange}
            className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
          />
          {busy && (
            <p className="text-xs text-muted-foreground">Uploading…</p>
          )}
        </div>
      </section>
    </div>
  );
}
