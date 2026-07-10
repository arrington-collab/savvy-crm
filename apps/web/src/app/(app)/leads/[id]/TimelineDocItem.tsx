"use client";
import { useState } from "react";
import { DocViewer, type ViewerDoc } from "@/components/DocViewer";
import { ago } from "@/lib/format";

const DOC_KIND_LABELS: Record<string, string> = {
  insurance_estimate: "Insurance estimate",
  measurement_report: "Measurement report",
  photo: "Photo",
  contract: "Contract",
  other: "Other",
};

/** A document event in the lead timeline: click the filename to open it in the viewer. */
export function TimelineDocItem({ id, filename, mime, uploaderName, at, docKind }: {
  id: string;
  filename: string | null;
  mime: string | null;
  uploaderName: string | null;
  at: Date;
  docKind: string;
}) {
  const [viewing, setViewing] = useState<ViewerDoc | null>(null);
  return (
    <li className="flex items-start gap-2 text-sm">
      <span
        className="mt-0.5 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
        style={{ background: "var(--surface-muted)", color: "var(--text-muted)" }}
      >
        Doc
      </span>
      <div className="min-w-0">
        <div className="mono text-xs" style={{ color: "var(--text-faint)" }}>
          {DOC_KIND_LABELS[docKind] ?? docKind} · {uploaderName ?? "system"} · {ago(at)}
        </div>
        <button
          className="mt-0.5 block max-w-full truncate text-left text-sm underline underline-offset-2"
          style={{ color: "var(--text-body)" }}
          onClick={() => setViewing({ id, filename, mime, uploaderName, createdAt: at })}
          data-testid={`timeline-doc-${id}`}
        >
          {filename ?? "(unnamed document)"}
        </button>
      </div>
      <DocViewer doc={viewing} onClose={() => setViewing(null)} />
    </li>
  );
}
