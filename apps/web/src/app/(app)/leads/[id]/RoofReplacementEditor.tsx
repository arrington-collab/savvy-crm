"use client";
import { useState, useTransition } from "react";
import { ROOF_REPLACEMENT_SOURCE_VALUES } from "@savvy/core";
import { setRoofReplacement } from "@/lib/lead-actions";
import { Card } from "@/components/ui/card";

const LABELS: Record<string, string> = {
  owner_reported: "Owner reported",
  permit: "Permit",
  assessor: "Assessor",
};

/**
 * Lets a human capture the last roof-replacement date + source on a property.
 * The server action rejects invalid sources, invalid dates, and future dates.
 */
export function RoofReplacementEditor({
  leadId,
  propertyId,
  at,
  source,
}: {
  leadId: string;
  propertyId: string | null;
  at: string | null;
  source: string | null;
}) {
  const [dateValue, setDateValue] = useState(at ?? "");
  const [sourceValue, setSourceValue] = useState(source ?? "owner_reported");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!propertyId) return null;

  function save() {
    setSaved(false);
    setError(null);
    if (!dateValue) return;
    start(async () => {
      const r = await setRoofReplacement(leadId, propertyId!, { at: dateValue, source: sourceValue });
      if ("ok" in r) setSaved(true);
      else setError(r.error);
    });
  }

  return (
    <Card className="p-4 flex items-center gap-3 text-sm">
      <span style={{ color: "var(--text-faint)" }}>Roof replaced</span>
      <input
        type="date"
        data-testid="roof-replacement-date"
        value={dateValue}
        disabled={pending}
        onChange={(e) => {
          setDateValue(e.target.value);
        }}
        className="rounded-md border bg-transparent px-2 py-1"
        style={{ borderColor: "var(--border)", color: "var(--text-body)" }}
      />
      <span style={{ color: "var(--text-faint)" }}>Source</span>
      <select
        data-testid="roof-replacement-source"
        value={sourceValue}
        disabled={pending}
        onChange={(e) => setSourceValue(e.target.value)}
        className="rounded-md border bg-transparent px-2 py-1"
        style={{ borderColor: "var(--border)", color: "var(--text-body)" }}
      >
        {ROOF_REPLACEMENT_SOURCE_VALUES.map((s) => (
          <option key={s} value={s}>{LABELS[s]}</option>
        ))}
      </select>
      <button
        type="button"
        data-testid="roof-replacement-save"
        disabled={pending || !dateValue}
        onClick={save}
        className="rounded-md border px-2 py-1"
        style={{ borderColor: "var(--border)", color: "var(--text-body)" }}
      >
        Save
      </button>
      {saved && <span style={{ color: "var(--accent-gold)" }}>Saved ✓</span>}
      {error && <span style={{ color: "var(--accent-red, red)" }}>{error}</span>}
    </Card>
  );
}
