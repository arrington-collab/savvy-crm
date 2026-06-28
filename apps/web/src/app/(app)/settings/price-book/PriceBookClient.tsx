"use client";
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { updatePriceBookItem } from "@/lib/price-book-actions";
import type { listPriceBook } from "@/lib/price-book-queries";
import { PageHeader } from "@/components/cockpit/PageHeader";

type PriceBookRow = Awaited<ReturnType<typeof listPriceBook>>[number];

function PriceBookRowItem({ item, index }: { item: PriceBookRow; index: number }) {
  // Store price as dollars string for the input; send as cents to server
  const [priceDollars, setPriceDollars] = useState(
    (item.unitPriceCents / 100).toFixed(2),
  );
  // Store supplier cost as dollars string for the input; send as cents to server
  const [costDollars, setCostDollars] = useState(
    (item.unitCostCents / 100).toFixed(2),
  );
  const [wasteApplies, setWasteApplies] = useState(item.wasteApplies);
  const [active, setActive] = useState(item.active);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    const cents = Math.round(parseFloat(priceDollars) * 100);
    const costCents = Math.round(parseFloat(costDollars) * 100);
    await updatePriceBookItem({
      id: item.id,
      unitPriceCents: isNaN(cents) ? item.unitPriceCents : cents,
      unitCostCents: isNaN(costCents) ? item.unitCostCents : costCents,
      wasteApplies,
      active,
      sourceFields: item.sourceFields ?? [],
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <Card
      className="p-4"
      data-testid="price-book-row"
      data-key={item.key}
      style={{ background: index % 2 ? "var(--surface-panel)" : "transparent" }}
    >
      <div className="grid grid-cols-[2fr_1fr_1fr_2fr_1fr_1fr_1fr_auto] gap-3 items-center text-sm">
        {/* Name */}
        <span className="font-medium truncate" style={{ color: "var(--text-body)" }}>{item.name}</span>

        {/* Category */}
        <span className="capitalize" style={{ color: "var(--text-muted)" }}>{item.category}</span>

        {/* Unit */}
        <span style={{ color: "var(--text-muted)" }}>{item.unit}</span>

        {/* Source fields */}
        <span className="text-xs truncate" style={{ color: "var(--text-muted)" }}>
          {(item.sourceFields ?? []).join(", ") || "—"}
        </span>

        {/* Unit price (editable) */}
        <div className="flex items-center gap-1">
          <span className="mono text-xs" style={{ color: "var(--text-muted)" }}>$</span>
          <Input
            type="number"
            min="0"
            step="0.01"
            value={priceDollars}
            onChange={(e) => setPriceDollars(e.target.value)}
            className="h-7 w-24 text-sm mono"
            aria-label={`Unit price for ${item.name}`}
          />
        </div>

        {/* Supplier cost (editable) */}
        <div className="flex items-center gap-1">
          <span className="mono text-xs" style={{ color: "var(--text-muted)" }}>$</span>
          <Input
            type="number"
            min="0"
            step="0.01"
            value={costDollars}
            onChange={(e) => setCostDollars(e.target.value)}
            className="h-7 w-24 text-sm mono"
            aria-label={`Supplier cost for ${item.name}`}
            data-testid="pb-cost-input"
          />
        </div>

        {/* Toggles */}
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1 text-xs cursor-pointer" style={{ color: "var(--text-body)" }}>
            <Checkbox
              checked={wasteApplies}
              onChange={(e) => setWasteApplies(e.target.checked)}
              aria-label={`Waste applies for ${item.name}`}
            />
            Waste
          </label>
          <label className="flex items-center gap-1 text-xs cursor-pointer" style={{ color: "var(--text-body)" }}>
            <Checkbox
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              aria-label={`Active toggle for ${item.name}`}
            />
            Active
          </label>
        </div>

        {/* Save button */}
        <Button
          size="sm"
          variant="outline"
          onClick={handleSave}
          disabled={saving}
          className="h-7 text-xs"
        >
          {saving ? "Saving…" : saved ? "Saved ✓" : "Save"}
        </Button>
      </div>
    </Card>
  );
}

export function PriceBookClient({ items }: { items: PriceBookRow[] }) {
  if (items.length === 0) {
    return (
      <div className="space-y-4">
        <PageHeader eyebrow="Catalog" title="Price Book" />
        <p style={{ color: "var(--text-faint)" }}>No price book items yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <PageHeader eyebrow="Catalog" title="Price Book" />

      {/* Header */}
      <div className="grid grid-cols-[2fr_1fr_1fr_2fr_1fr_1fr_1fr_auto] gap-3 px-4 eyebrow">
        <span>Name</span>
        <span>Category</span>
        <span>Unit</span>
        <span>Source Fields</span>
        <span>Unit Price</span>
        <span>Supplier Cost</span>
        <span>Options</span>
        <span />
      </div>

      {items.map((item, i) => (
        <PriceBookRowItem key={item.id} item={item} index={i} />
      ))}
    </div>
  );
}
