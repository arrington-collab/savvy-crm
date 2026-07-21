"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { presignDocumentUpload, recordDocument, reparseDocument } from "@/lib/document-actions";
import { linkCompanyCamProject } from "@/lib/companycam-actions";
import { Button } from "@/components/ui/button";
import { DocViewer, type ViewerDoc } from "@/components/DocViewer";
import { PhotoAnnotator, type AnnotatorDoc } from "./PhotoAnnotator";
import { parseSummaryView, type DocParseSummary } from "@savvy/core";

// Mirrors the columns selected in page.tsx
export interface DocRow {
  id: string;
  kind: string;
  label: string | null;
  notes: string | null;
  filename: string | null;
  mime: string | null;
  source: string | null;
  externalUrl: string | null;
  parseStatus: string;
  uploaderName: string | null;
  createdAt: string;
}

interface Props {
  jobId: string;
  documents: DocRow[];
  parseSummaries: Record<string, DocParseSummary>;
  requiredPhotos: string[];
  companycamProjectId: string | null;
}

const KIND_OPTIONS = ["photo", "measurement", "contract", "evidence", "other"] as const;
type DocKind = (typeof KIND_OPTIONS)[number];

// ─── DocThumb ────────────────────────────────────────────────────────────────
// Loads a server-downscaled (?w=192), immutably-cached thumbnail through the
// same-origin proxy. No presign round-trip, lazy-loaded so off-screen thumbs in
// a long grid don't fetch until scrolled to.
function DocThumb({ docId, filename }: { docId: string; filename: string | null }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="flex h-24 w-24 items-center justify-center rounded-md border border-border bg-muted text-xs text-muted-foreground">
        unavailable
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/api/documents/${docId}/view?w=192`}
      alt={filename ?? "document photo"}
      width={96}
      height={96}
      loading="lazy"
      onError={() => setFailed(true)}
      className="h-24 w-24 rounded-md border border-border bg-muted object-cover"
    />
  );
}

// ─── DocsPanel ───────────────────────────────────────────────────────────────
export function DocsPanel({ jobId, documents, parseSummaries, requiredPhotos, companycamProjectId }: Props) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, startBusy] = useTransition();
  const [ccProjectId, setCcProjectId] = useState(companycamProjectId ?? "");
  const [ccSaving, startCcSave] = useTransition();
  const [viewing, setViewing] = useState<ViewerDoc | null>(null);
  // The gallery opens at the clicked photo's index and pages through them all.
  const [galleryIndex, setGalleryIndex] = useState<number | null>(null);

  const [selectedLabel, setSelectedLabel] = useState<string>(requiredPhotos[0] ?? "other");
  const [selectedKind, setSelectedKind] = useState<DocKind>("photo");

  const photos = documents.filter((d) => d.kind === "photo");
  const galleryDocs: AnnotatorDoc[] = photos.map((d) => ({
    id: d.id, filename: d.filename, label: d.label, notes: d.notes, externalUrl: d.externalUrl,
  }));
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

  function handleLinkSave() {
    startCcSave(async () => {
      const res = await linkCompanyCamProject(jobId, ccProjectId);
      if ("ok" in res) {
        toast.success("CompanyCam project linked.");
        router.refresh();
      } else {
        toast.error(`Could not link project (${res.error}).`);
      }
    });
  }

  return (
    <div className="space-y-6">
      {/* ── 0. CompanyCam project link ──────────────────────────────────── */}
      <section className="space-y-2 rounded-md border border-border p-4">
        <h3 className="text-sm font-semibold">CompanyCam project</h3>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={ccProjectId}
            onChange={(e) => setCcProjectId(e.target.value)}
            placeholder="Project ID"
            data-testid="companycam-link"
            className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          />
          <Button
            size="sm"
            variant="outline"
            disabled={ccSaving}
            onClick={handleLinkSave}
            data-testid="companycam-link-save"
          >
            {ccSaving ? "Saving…" : "Save"}
          </Button>
        </div>
        {companycamProjectId && (
          <p className="text-xs text-muted-foreground">
            Linked: <span className="font-mono">{companycamProjectId}</span>
          </p>
        )}
      </section>

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
            {photos.map((doc, i) => (
              <div key={doc.id} className="space-y-1">
                {doc.externalUrl ? (
                  <button
                    type="button"
                    onClick={() => setGalleryIndex(i)}
                    className="block rounded-md ring-offset-2 ring-offset-background transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    title="Open · view & notes"
                    data-testid={`open-photo-${doc.id}`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={doc.externalUrl}
                      alt={doc.label ?? "photo"}
                      loading="lazy"
                      className="h-24 w-24 rounded-md border border-border object-cover"
                      data-testid="companycam-photo"
                    />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setGalleryIndex(i)}
                    className="block rounded-md ring-offset-2 ring-offset-background transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    title="Open · view, notes & markup"
                    data-testid={`open-photo-${doc.id}`}
                  >
                    <DocThumb docId={doc.id} filename={doc.filename} />
                  </button>
                )}
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
            {nonPhotos.map((doc) => {
              const summary = parseSummaries[doc.id];
              const view = summary ? parseSummaryView(summary) : null;
              const parseable = doc.kind === "insurance_estimate" || doc.kind === "measurement_report";
              return (
                <div key={doc.id} className="rounded-md border border-border p-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-muted-foreground">{doc.filename ?? "file"}</span>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setViewing({ id: doc.id, filename: doc.filename, mime: doc.mime, uploaderName: doc.uploaderName, createdAt: doc.createdAt })}
                        data-testid={`view-doc-${doc.id}`}
                      >
                        View
                      </Button>
                      {parseable && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={async () => {
                            const r = await reparseDocument(doc.id);
                            if ("ok" in r) { toast.success("Re-parsing…"); router.refresh(); }
                            else toast.error(`Re-parse failed: ${r.error}`);
                          }}
                        >
                          Re-run parse
                        </Button>
                      )}
                    </div>
                  </div>
                  {view && view.rows.length > 0 && (
                    <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
                      {view.rows.map((r) => (
                        <div key={r.label} className="flex justify-between gap-2">
                          <dt className="text-muted-foreground">{r.label}</dt>
                          <dd className="font-medium">{r.value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  {view && view.rows.length === 0 && (
                    <p className="mt-1 text-xs text-muted-foreground">{view.headline}</p>
                  )}
                </div>
              );
            })}
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

      <DocViewer doc={viewing} onClose={() => setViewing(null)} />
      {galleryIndex !== null && galleryDocs.length > 0 && (
        <PhotoAnnotator
          docs={galleryDocs}
          startIndex={galleryIndex}
          jobId={jobId}
          onClose={() => setGalleryIndex(null)}
          onSaved={() => router.refresh()}
        />
      )}
    </div>
  );
}
