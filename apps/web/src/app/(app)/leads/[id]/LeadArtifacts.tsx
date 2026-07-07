import Link from "next/link";
import { Card } from "@/components/ui/card";
import type { LeadArtifacts } from "@savvy/db";

function money(cents: number | null): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs" style={{ color: "var(--text-faint)" }}>{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

/**
 * Lead tile: the Measurement + Estimate sections. Summary fields are read-only; the
 * Measurement card links to the DIY roof-sketch editor so a rep can produce the
 * measurement (and thus the estimate) before any job exists.
 */
export function LeadArtifactsSections({
  artifacts,
  leadId,
  hasProperty,
}: {
  artifacts: LeadArtifacts;
  leadId: string;
  hasProperty: boolean;
}) {
  const { measurement: m, estimate: e } = artifacts;
  const hasSketch = m?.source === "sketch" || m?.provider === "diy";
  return (
    <>
      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="eyebrow">Measurement</div>
          {hasProperty ? (
            <Link
              href={`/leads/${leadId}/measure`}
              className="text-sm underline underline-offset-2"
              data-testid="lead-draw-roof"
            >
              {hasSketch ? "Edit sketch" : "Draw roof"}
            </Link>
          ) : (
            <span
              className="text-sm"
              style={{ color: "var(--text-faint)" }}
              title="Add the property address first"
              data-testid="lead-draw-roof-disabled"
            >
              Draw roof
            </span>
          )}
        </div>
        {m ? (
          <dl className="grid grid-cols-3 gap-3 text-sm">
            <Field label="Source" value={
              m.source === "uploaded_report" ? "Uploaded report"
              : m.source === "sketch" ? "DIY sketch"
              : m.source === "ordered" ? "Roofr"
              : (m.provider === "diy" ? "DIY sketch" : "Roofr")
            } />
            <Field label="Squares" value={m.squares != null ? String(m.squares) : "—"} />
            <Field label="Pitch" value={m.pitch ?? "—"} />
            {m.reportUrl ? (
              <div className="col-span-3">
                <a href={m.reportUrl} target="_blank" rel="noreferrer" className="text-sm underline">View report</a>
              </div>
            ) : null}
          </dl>
        ) : (
          <p className="text-sm" style={{ color: "var(--text-faint)" }}>
            No measurement yet — auto-ordered when the inspection is booked.
          </p>
        )}
      </Card>

      <Card className="p-4">
        <div className="eyebrow mb-3">Estimate</div>
        {e ? (
          <dl className="grid grid-cols-3 gap-3 text-sm">
            <Field label="Status" value={e.approvalRequiredAt ? "Awaiting approval" : e.status} />
            <Field label="Total" value={money(e.total)} />
            <Field label="Waste" value={e.wastePctUsed != null ? `${Math.round(e.wastePctUsed / 100)}%` : "—"} />
          </dl>
        ) : (
          <p className="text-sm" style={{ color: "var(--text-faint)" }}>
            No estimate yet — drafts automatically once the inspection is complete and a measurement has landed.
          </p>
        )}
      </Card>
    </>
  );
}
