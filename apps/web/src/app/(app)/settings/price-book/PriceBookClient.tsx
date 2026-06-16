"use client";
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { updatePriceBookItem } from "@/lib/price-book-actions";
import type { listPriceBook } from "@/lib/price-book-queries";

type PriceBookRow = Awaited<ReturnType<typeof listPriceBook>>[number];

function fmtUsd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function PriceBookRowItem({ item }: { item: PriceBookRow }) {
  // Store price as dollars string for the input; send as cents to server
  const [priceDollars, setPriceDollars] = useState(
    (item.unitPriceCents / 100).toFixed(2),
  );
  const [wasteApplies, setWasteApplies] = useState(item.wasteApplies);
  const [active, setActive] = useState(item.active);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    const cents = Math.round(parseFloat(priceDollars) * 100);
    await updatePriceBookItem({
      id: item.id,
      unitPriceCents: isNaN(cents) ? item.unitPriceCents : cents,
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
    >
      <div className="grid grid-cols-[2fr_1fr_1fr_2fr_1fr_1fr_auto] gap-3 items-center text-sm">
        {/* Name */}
        <span className="font-medium truncate">{item.name}</span>

        {/* Category */}
        <span className="capitalize text-muted-foreground">{item.category}</span>

        {/* Unit */}
        <span className="text-muted-foreground">{item.unit}</span>

        {/* Source fields */}
        <span className="text-xs text-muted-foreground truncate">
          {(item.sourceFields ?? []).join(", ") || "—"}
        </span>

        {/* Unit price (editable) */}
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground text-xs">$</span>
          <Input
            type="number"
            min="0"
            step="0.01"
            value={priceDollars}
            onChange={(e) => setPriceDollars(e.target.value)}
            className="h-7 w-24 text-sm"
            aria-label={`Unit price for ${item.name}`}
          />
        </div>

        {/* Toggles */}
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1 text-xs cursor-pointer">
            <Checkbox
              checked={wasteApplies}
              onChange={(e) => setWasteApplies(e.target.checked)}
              aria-label={`Waste applies for ${item.name}`}
            />
            Waste
          </label>
          <label className="flex items-center gap-1 text-xs cursor-pointer">
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
      <p className="text-sm text-muted-foreground">No price book items yet.</p>
    );
  }

  return (
    <div className="space-y-2">
      {/* Header */}
      <div className="grid grid-cols-[2fr_1fr_1fr_2fr_1fr_1fr_auto] gap-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">
        <span>Name</span>
        <span>Category</span>
        <span>Unit</span>
        <span>Source Fields</span>
        <span>Unit Price</span>
        <span>Options</span>
        <span />
      </div>

      {items.map((item) => (
        <PriceBookRowItem key={item.id} item={item} />
      ))}
    </div>
  );
}
