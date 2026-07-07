"use client";
import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import { presignLeadDocumentUpload, recordLeadDocumentAction } from "@/lib/document-actions";
import type { LeadDocumentRow } from "@savvy/db";

const KINDS = ["insurance_estimate", "measurement_report", "photo", "contract", "other"] as const;
const KIND_LABELS: Record<string, string> = {
  insurance_estimate: "Insurance estimate",
  measurement_report: "Measurement report",
  photo: "Photo",
  contract: "Contract",
  other: "Other",
};
const PARSE_LABELS: Record<string, string> = {
  pending: "Pending",
  parsed: "Parsed",
  parse_failed: "Parse failed",
  unparsed_low_confidence: "Stored, unparsed",
};

function fmtTime(d: Date | string): string {
  return new Date(d).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function LeadDocsCard({ leadId, documents }: { leadId: string; documents: LeadDocumentRow[] }) {
  const router = useRouter();
  const [kind, setKind] = useState<string>("insurance_estimate");
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setBusy(true);
    try {
      const pres = await presignLeadDocumentUpload({
        leadId, kind, filename: file.name, contentType: file.type, sizeBytes: file.size,
      });
      if (!("ok" in pres)) {
        toast.error(`Upload rejected: ${pres.error}`);
        return;
      }
      const put = await fetch(pres.uploadUrl, { method: "PUT", body: file, headers: { "content-type": file.type } });
      if (!put.ok) {
        toast.error("Upload to storage failed");
        return;
      }
      const rec = await recordLeadDocumentAction({
        leadId, r2Key: pres.r2Key, kind, filename: file.name, mime: file.type, sizeBytes: file.size,
      });
      if (!("ok" in rec)) {
        toast.error(`Could not record document: ${rec.error}`);
        return;
      }
      toast.success("Document uploaded");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-4" data-testid="lead-docs-card">
      <div className="eyebrow mb-3">Documents</div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select
          className="rounded border px-2 py-1 text-sm"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          aria-label="Document type"
        >
          {KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
        </select>
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) void upload(f);
        }}
        onClick={() => inputRef.current?.click()}
        className="mb-4 cursor-pointer rounded border border-dashed p-4 text-center text-sm"
        style={{ borderColor: dragOver ? "var(--text-muted)" : "var(--border)", color: "var(--text-muted)" }}
        data-testid="lead-docs-dropzone"
      >
        {busy ? "Uploading…" : "Drop a file here, or click to choose (PDF for insurance / measurement; 25MB max)"}
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          accept="application/pdf,image/jpeg,image/png,image/webp,image/heic"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
            e.target.value = "";
          }}
        />
      </div>

      {documents.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--text-faint)" }}>No documents yet.</p>
      ) : (
        <ul className="space-y-2">
          {documents.map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-2 text-sm">
              <div>
                <div className="font-medium">{d.filename ?? "(unnamed)"}</div>
                <div className="mono text-xs" style={{ color: "var(--text-faint)" }}>
                  {KIND_LABELS[d.kind] ?? d.kind} · {d.uploaderName ?? "system"} · {fmtTime(d.createdAt)}
                </div>
              </div>
              <span
                className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
                style={{ background: "var(--surface-muted)", color: "var(--text-muted)" }}
              >
                {PARSE_LABELS[d.parseStatus] ?? d.parseStatus}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
