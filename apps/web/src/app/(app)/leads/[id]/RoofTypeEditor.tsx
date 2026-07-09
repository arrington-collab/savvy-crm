"use client";
import { useState, useTransition } from "react";
import { ROOF_TYPE_VALUES } from "@savvy/core";
import { setPropertyRoofTypes } from "@/lib/lead-actions";
import { Card } from "@/components/ui/card";

const LABELS: Record<string, string> = {
  asphalt_shingle: "Asphalt shingle",
  tile: "Tile",
  metal: "Metal",
  flat_foam: "Flat-foam",
  other: "Other",
};

/**
 * Lets a human capture the roof type(s) on a property that the agents couldn't fill —
 * resolves the `roof_type_needed` exception (the row clears once the primary roof_type
 * is set; the secondary is optional and never gates the exception).
 */
export function RoofTypeEditor({
  leadId,
  propertyId,
  current,
  secondary,
}: {
  leadId: string;
  propertyId: string | null;
  current: string | null;
  secondary: string | null;
}) {
  const [value, setValue] = useState(current ?? "");
  const [secondaryValue, setSecondaryValue] = useState(secondary ?? "");
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  if (!propertyId) return null;

  function save(primary: string, secondaryVal: string) {
    setSaved(false);
    if (!primary) return;
    start(async () => {
      const r = await setPropertyRoofTypes(leadId, propertyId!, { primary, secondary: secondaryVal || null });
      if ("ok" in r) setSaved(true);
    });
  }

  return (
    <Card className="p-4 flex items-center gap-3 text-sm">
      <span style={{ color: "var(--text-faint)" }}>Roof type</span>
      <select
        data-testid="roof-type-edit"
        value={value}
        disabled={pending}
        onChange={(e) => {
          const v = e.target.value;
          setValue(v);
          save(v, secondaryValue);
        }}
        className="rounded-md border bg-transparent px-2 py-1"
        style={{ borderColor: "var(--border)", color: "var(--text-body)" }}
      >
        <option value="">Select…</option>
        {ROOF_TYPE_VALUES.map((rt) => (
          <option key={rt} value={rt}>{LABELS[rt]}</option>
        ))}
      </select>
      <span style={{ color: "var(--text-faint)" }}>Secondary</span>
      <select
        data-testid="roof-type-secondary-edit"
        value={secondaryValue}
        disabled={pending}
        onChange={(e) => {
          const v = e.target.value;
          setSecondaryValue(v);
          save(value, v);
        }}
        className="rounded-md border bg-transparent px-2 py-1"
        style={{ borderColor: "var(--border)", color: "var(--text-body)" }}
      >
        <option value="">— none —</option>
        {ROOF_TYPE_VALUES.map((rt) => (
          <option key={rt} value={rt}>{LABELS[rt]}</option>
        ))}
      </select>
      {saved && <span style={{ color: "var(--accent-gold)" }}>Saved ✓</span>}
    </Card>
  );
}
