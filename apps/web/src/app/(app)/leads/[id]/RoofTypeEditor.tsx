"use client";
import { useState, useTransition } from "react";
import { ROOF_TYPE_VALUES } from "@savvy/core";
import { setPropertyRoofType } from "@/lib/lead-actions";
import { Card } from "@/components/ui/card";

const LABELS: Record<string, string> = {
  asphalt_shingle: "Asphalt shingle",
  tile: "Tile",
  metal: "Metal",
  flat_foam: "Flat-foam",
  other: "Other",
};

/**
 * Lets a human capture the roof type on a property that the agents couldn't fill —
 * resolves the `roof_type_needed` exception (the row clears once roof_type is set).
 */
export function RoofTypeEditor({ leadId, propertyId, current }: { leadId: string; propertyId: string | null; current: string | null }) {
  const [value, setValue] = useState(current ?? "");
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  if (!propertyId) return null;

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
          setSaved(false);
          if (v) start(async () => {
            const r = await setPropertyRoofType(leadId, propertyId, v);
            if ("ok" in r) setSaved(true);
          });
        }}
        className="rounded-md border bg-transparent px-2 py-1"
        style={{ borderColor: "var(--border)", color: "var(--text-body)" }}
      >
        <option value="">Select…</option>
        {ROOF_TYPE_VALUES.map((rt) => (
          <option key={rt} value={rt}>{LABELS[rt]}</option>
        ))}
      </select>
      {saved && <span style={{ color: "var(--accent-gold)" }}>Saved ✓</span>}
    </Card>
  );
}
