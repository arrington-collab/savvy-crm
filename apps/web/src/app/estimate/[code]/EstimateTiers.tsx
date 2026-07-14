"use client";
import { useState } from "react";
import type { EstimatePageTier } from "@savvy/core";

const usd = (cents: number) =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

// Tier cards + per-tier color selector. Selection persists to the estimate the
// moment it's tapped (validated server-side). The Accept CTA is rendered but
// wired in slice 3 — the page never promises what the flow can't do yet.
export function EstimateTiers({
  code,
  tiers,
  initialTier,
  initialColor,
  warranties,
  expired,
}: {
  code: string;
  tiers: EstimatePageTier[];
  initialTier: EstimatePageTier["tier"] | null;
  initialColor: string | null;
  warranties: Record<string, string>;
  expired: boolean;
}) {
  const [tier, setTier] = useState<EstimatePageTier["tier"] | null>(initialTier);
  const [color, setColor] = useState<string | null>(initialColor);
  const [saving, setSaving] = useState(false);

  const active = tiers.find((t) => t.tier === tier) ?? null;

  async function pickColor(next: string) {
    if (!tier) return;
    setColor(next);
    setSaving(true);
    try {
      await fetch(`/api/estimate/${code}/selection`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier, color: next }),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3" data-testid="estimate-tiers">
        {tiers.map((t) => (
          <button
            key={t.tier}
            data-testid={`tier-card-${t.tier}`}
            onClick={() => { if (t.tier !== tier) { setTier(t.tier); setColor(null); } }}
            className={`rounded-xl border p-4 text-left transition ${
              tier === t.tier ? "border-stone-800 ring-1 ring-stone-800" : "border-stone-200"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs uppercase tracking-wide text-stone-500">{t.tier}</span>
              {t.recommended && (
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
                  Recommended
                </span>
              )}
            </div>
            <p className="mt-1 font-semibold">{t.productName}</p>
            <ul className="mt-2 space-y-1 text-xs text-stone-500">
              {t.bullets.map((b) => (
                <li key={b}>• {b}</li>
              ))}
            </ul>
            <p className="mt-3 text-xl font-semibold" data-testid={`tier-total-${t.tier}`}>
              {t.subtotalCents == null ? "Ask us" : usd(t.subtotalCents)}
            </p>
          </button>
        ))}
      </div>

      {active && active.colors.length > 0 && (
        <div className="space-y-2" data-testid="color-selector">
          <p className="text-sm font-medium">
            Pick your {active.productName} color{" "}
            <span className="font-normal text-stone-400">(subject to supplier availability)</span>
          </p>
          <div className="flex flex-wrap gap-2">
            {active.colors.map((c) => (
              <button
                key={c.name}
                data-testid={`color-${c.name.replace(/\s+/g, "-").toLowerCase()}`}
                onClick={() => pickColor(c.name)}
                className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm ${
                  color === c.name ? "border-stone-800 ring-1 ring-stone-800" : "border-stone-200"
                }`}
              >
                <span className="h-4 w-4 rounded-full border border-stone-300" style={{ background: c.hex }} />
                {c.name}
                {saving && color === c.name ? "…" : color === c.name ? " ✓" : ""}
              </button>
            ))}
          </div>
        </div>
      )}

      {active && (
        <div className="rounded-lg border border-stone-200 p-4 text-sm" data-testid="warranty-panel">
          <p className="font-medium">Warranty — {active.productName}</p>
          <p className="mt-1 text-stone-600">{warranties[active.tier] ?? ""}</p>
          <p className="mt-1 text-stone-500">Plus our workmanship warranty on the installation itself.</p>
        </div>
      )}

      <button
        data-testid="accept-cta"
        disabled
        title="Online acceptance is coming — call or reply to accept today"
        className="w-full rounded-xl bg-stone-300 py-3 font-semibold text-stone-500"
      >
        {expired ? "Ask us to refresh this estimate" : "Accept & schedule — coming right up"}
      </button>
    </section>
  );
}
