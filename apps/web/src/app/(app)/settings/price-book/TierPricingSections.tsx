"use client";
import { useState, useTransition } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { saveTierProduct, parsePriceSheetAction, applyPriceBookDiffAction } from "@/lib/price-book-actions";
import type { getPriceBookMeta } from "@/lib/price-book-queries";

type Meta = Awaited<ReturnType<typeof getPriceBookMeta>>;
type TierRow = Meta["tiers"][number];
type DiffChange = Meta["drift"]["changes"][number];

const usd = (cents: number | null | undefined) =>
  cents == null ? "—" : `$${(cents / 100).toFixed(2)}`;
const pct = (bps: number) => `${(bps / 100).toFixed(1)}%`;

// ── "Price book needs costs" card ────────────────────────────────────────────
export function NeedsCostsBanner({ needs }: { needs: string[] }) {
  if (needs.length === 0) return null;
  return (
    <Card className="p-4" data-testid="needs-costs-card" style={{ borderColor: "var(--accent-amber, #b45309)" }}>
      <p className="text-sm font-medium" style={{ color: "var(--text-body)" }}>
        Price book needs costs
      </p>
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        {needs.length} tier slot{needs.length === 1 ? "" : "s"} unfilled ({needs.join(", ")}). Tier
        estimates can&apos;t price until these are real numbers — we never invent costs.
      </p>
    </Card>
  );
}

// ── Good / Better / Best products ────────────────────────────────────────────
function TierProductRow({ t }: { t: TierRow }) {
  const [price, setPrice] = useState(t.unitPriceCents == null ? "" : (t.unitPriceCents / 100).toFixed(2));
  const [cost, setCost] = useState(t.unitCostCents == null ? "" : (t.unitCostCents / 100).toFixed(2));
  const [warranty, setWarranty] = useState(t.warrantyText);
  const [palette, setPalette] = useState((t.colorPalette ?? []).map((c) => `${c.name}:${c.hex}`).join(", "));
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);

  const toCents = (s: string) => {
    const n = Math.round(parseFloat(s) * 100);
    return Number.isFinite(n) ? n : null;
  };

  return (
    <Card className="p-4 space-y-2" data-testid={`tier-product-${t.tier}`}>
      <div className="flex items-center gap-2">
        <span className="eyebrow uppercase">{t.tier}</span>
        <span className="font-medium" style={{ color: "var(--text-body)" }}>
          {t.productName}
        </span>
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>{t.manufacturer}</span>
        {t.recommended && (
          <span className="text-xs rounded px-1.5 py-0.5" style={{ background: "var(--surface-panel)", color: "var(--text-body)" }}>
            Recommended
          </span>
        )}
      </div>
      <div className="grid grid-cols-[1fr_1fr_3fr_auto] gap-3 items-center text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>Price / square</span>
          <Input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="unpriced" className="h-8" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>Cost / square</span>
          <Input value={cost} onChange={(e) => setCost(e.target.value)} placeholder="unknown" className="h-8" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>Colors (name:hex, comma-separated)</span>
          <Input value={palette} onChange={(e) => setPalette(e.target.value)} className="h-8" />
        </label>
        <Button
          size="sm"
          className="h-8 self-end"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const colorPalette = palette
                .split(",")
                .map((p) => p.trim())
                .filter(Boolean)
                .map((p) => {
                  const [name, hex] = p.split(":").map((x) => x.trim());
                  return { name: name ?? "", hex: hex ?? "#000000" };
                });
              await saveTierProduct({
                id: t.id,
                unitPriceCents: toCents(price),
                unitCostCents: toCents(cost),
                warrantyText: warranty,
                colorPalette,
              });
              setSaved(true);
              setTimeout(() => setSaved(false), 2000);
            })
          }
        >
          {pending ? "Saving…" : saved ? "Saved ✓" : "Save"}
        </Button>
      </div>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>Warranty text (renders on the estimate)</span>
        <Input value={warranty} onChange={(e) => setWarranty(e.target.value)} className="h-8" />
      </label>
    </Card>
  );
}

export function TierProductsSection({ tiers }: { tiers: TierRow[] }) {
  const order = { good: 0, better: 1, best: 2 } as Record<string, number>;
  return (
    <section className="space-y-2" data-testid="tier-products">
      <h2 className="eyebrow">Good / Better / Best</h2>
      {[...tiers].sort((a, b) => (order[a.tier] ?? 9) - (order[b.tier] ?? 9)).map((t) => (
        <TierProductRow key={t.id} t={t} />
      ))}
    </section>
  );
}

// ── Shared diff table + apply flow (sheet parse AND drift use this) ─────────
function DiffTable({
  changes,
  unmatched,
  source,
  note,
}: {
  changes: DiffChange[];
  unmatched: { name: string; unitCostCents: number }[];
  source: "ai_parse" | "drift";
  note: string;
}) {
  const [pending, start] = useTransition();
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const [applied, setApplied] = useState<number | null>(null);

  if (changes.length === 0 && unmatched.length === 0) return null;

  const apply = (confirm: boolean) =>
    start(async () => {
      const res = await applyPriceBookDiffAction({
        changes: changes.map((c) => ({ key: c.key, unitCostCents: c.newCostCents })),
        source,
        note,
        confirmUnderFloor: confirm,
      });
      if (!res.ok) setNeedsConfirm(true);
      else setApplied(res.versionNo);
    });

  return (
    <div className="space-y-2" data-testid={`diff-${source}`}>
      <table className="w-full text-sm">
        <thead>
          <tr className="eyebrow text-left">
            <th className="py-1">Item</th>
            <th>Old cost</th>
            <th>New cost</th>
            <th>Δ</th>
            <th>Margin @ current price</th>
          </tr>
        </thead>
        <tbody>
          {changes.map((c) => (
            <tr key={c.key} style={{ color: c.underFloor ? "var(--accent-amber, #b45309)" : "var(--text-body)" }}>
              <td className="py-1">{c.name}</td>
              <td>{usd(c.oldCostCents)}</td>
              <td>{usd(c.newCostCents)}</td>
              <td>{c.deltaCents > 0 ? "+" : ""}{usd(c.deltaCents)}</td>
              <td>
                {pct(c.newMarginBps)} {c.underFloor ? `— UNDER ${pct(c.floorBps)} floor` : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {unmatched.length > 0 && (
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          Not in the book (ignored, never guessed): {unmatched.map((u) => u.name).join(" · ")}
        </p>
      )}
      {applied != null ? (
        <p className="text-sm" data-testid="diff-applied" style={{ color: "var(--text-body)" }}>
          Applied as version {applied} ✓
        </p>
      ) : needsConfirm ? (
        <div className="flex items-center gap-3">
          <p className="text-sm" style={{ color: "var(--accent-amber, #b45309)" }}>
            This puts item(s) under their margin floor — confirm to apply anyway.
          </p>
          <Button size="sm" variant="destructive" disabled={pending} onClick={() => apply(true)}>
            Apply under floor
          </Button>
        </div>
      ) : (
        <Button size="sm" disabled={pending || changes.length === 0} onClick={() => apply(false)}>
          {pending ? "Applying…" : "Apply as new version"}
        </Button>
      )}
    </div>
  );
}

// ── Paste-a-price-sheet flow ─────────────────────────────────────────────────
export function SheetParseSection() {
  const [raw, setRaw] = useState("");
  const [pending, start] = useTransition();
  const [result, setResult] = useState<Awaited<ReturnType<typeof parsePriceSheetAction>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <section className="space-y-2" data-testid="sheet-parse">
      <h2 className="eyebrow">Fast price update — paste a supplier sheet</h2>
      <textarea
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        rows={5}
        placeholder="Paste the supplier price sheet / quote text here…"
        className="w-full rounded-md border p-2 text-sm"
        style={{ background: "transparent", borderColor: "var(--border-panel)", color: "var(--text-body)" }}
      />
      <Button
        size="sm"
        disabled={pending || raw.trim().length < 10}
        onClick={() =>
          start(async () => {
            setError(null);
            try {
              setResult(await parsePriceSheetAction(raw));
            } catch {
              setError("Couldn't parse that sheet — try again or trim it to the priced lines.");
            }
          })
        }
      >
        {pending ? "Parsing…" : "Parse with AI"}
      </Button>
      {error && <p className="text-sm" style={{ color: "var(--accent-amber, #b45309)" }}>{error}</p>}
      {result && (
        <DiffTable
          changes={result.diff.changes}
          unmatched={result.diff.unmatched}
          source="ai_parse"
          note={`sheet parse (${result.model})`}
        />
      )}
    </section>
  );
}

// ── Cost drift from supplier invoices (#136) ─────────────────────────────────
export function DriftSection({ drift }: { drift: Meta["drift"] }) {
  if (drift.changes.length === 0) return null;
  return (
    <section className="space-y-2" data-testid="cost-drift">
      <h2 className="eyebrow">Cost drift detected — recent supplier invoices vs your book</h2>
      <DiffTable changes={drift.changes} unmatched={[]} source="drift" note="supplier-invoice drift" />
    </section>
  );
}

// ── Version history ──────────────────────────────────────────────────────────
export function VersionsSection({ versions }: { versions: Meta["versions"] }) {
  if (versions.length === 0) return null;
  return (
    <section className="space-y-1" data-testid="price-book-versions">
      <h2 className="eyebrow">Versions</h2>
      {versions.map((v) => (
        <div key={v.id} className="flex items-center gap-3 text-sm px-1" style={{ color: "var(--text-muted)" }}>
          <span style={{ color: "var(--text-body)" }}>v{v.versionNo}</span>
          <span>{v.source}</span>
          {v.note && <span className="truncate">{v.note}</span>}
          <span>{new Date(v.createdAt).toLocaleDateString()}</span>
          {v.current && (
            <span className="text-xs rounded px-1.5" style={{ background: "var(--surface-panel)", color: "var(--text-body)" }}>
              current
            </span>
          )}
        </div>
      ))}
    </section>
  );
}
