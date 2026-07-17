import Link from "next/link";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/cockpit/PageHeader";
import { getCurrentUser } from "@/lib/current-user";
import { getOwnersRoom } from "@/lib/valuation-queries";
import { ValuationAskSage } from "./ValuationAskSage";

export const dynamic = "force-dynamic"; // always read live, tenant-scoped data

// The Owner's Room: an HONEST live estimate of what the company could sell
// for, and what would move it. Never a point, always a range; every
// adjustment named; "insufficient data" beats invented numbers.

function usd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
function usdM(cents: number): string {
  const m = cents / 100_000_000;
  return m >= 1 ? `$${m.toFixed(2)}M` : `$${Math.round(cents / 100_000)}K`;
}
function signedUsd(cents: number): string {
  return `${cents >= 0 ? "+" : "−"}${usd(Math.abs(cents))}`;
}
function mult(x: number): string {
  return `${x.toFixed(2)}×`;
}

const CAPTION = "Planning estimate from your operating data — not an appraisal or financial advice.";

const QUALITY_LABEL: Record<string, string> = { real: "measured", estimated: "estimated", missing: "unavailable" };

export default async function OwnersRoomPage() {
  const { role } = await getCurrentUser();
  // House rule: the valuation never leaves the owner tier; office is excluded
  // by default (Phase 26 role matrix).
  if (role === "office") redirect("/today");

  const { latest, quarterDeltaCents, levers, config } = await getOwnersRoom();
  const quality = (latest.inputQuality ?? { real: 0, estimated: 0, missing: 0 }) as { real: number; estimated: number; missing: number; flags?: Record<string, string> };
  const adjustments = (latest.adjustments ?? []) as { key: string; deltaLow: number; deltaHigh: number; rationale: string }[];

  // KPI strip straight from the snapshot's stored inputs — "—" for missing.
  const inp = (latest.inputs ?? {}) as Record<string, { value: number | null } | number | boolean | undefined>;
  const iv = (k: string): number | null => {
    const v = inp[k];
    return typeof v === "object" && v != null && "value" in v ? v.value : null;
  };
  const dash = (v: number | null, fmt: (n: number) => string) => (v == null ? "—" : fmt(v));
  const kpis = [
    { label: "TTM revenue", value: dash(iv("ttmRevenueCents"), usdM) },
    { label: "Gross margin", value: dash(iv("ttmGrossMarginPct"), (n) => `${n}%`) },
    { label: "Backlog", value: dash(iv("backlogCents"), usdM) },
    { label: "Maintenance MRR", value: dash(iv("maintenanceMrrCents"), usd) },
    { label: "Top customer", value: dash(iv("topCustomerPct"), (n) => `${n}%`) },
    { label: "Insurance mix", value: dash(iv("insuranceMixPct"), (n) => `${n}%`) },
    { label: "Coverage", value: dash(iv("coveragePct"), (n) => `${n}%`) },
    { label: "Founder-min/30d", value: dash(iv("founderMinutes30d"), (n) => `${n}`) },
  ];

  return (
    <div className="space-y-6" data-testid="owners-room-page">
      <ValuationAskSage snapshot={{
        status: latest.status, periodKey: latest.periodKey,
        valueLowCents: latest.valueLowCents, valueHighCents: latest.valueHighCents,
        adjustments, reasons: latest.reasons as string[] | null,
      }} />
      <PageHeader eyebrow="Money · Owner's Room" title="What the company could sell for" />
      <p className="mono -mt-4 text-xs" style={{ color: "var(--text-faint)" }}>{CAPTION}</p>

      {latest.status !== "ok" ? (
        <Card className="p-5" data-testid="valuation-insufficient">
          <p className="font-semibold" style={{ color: "var(--text-body)" }}>Not enough real data to price honestly — yet.</p>
          <p className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>
            The room shows a range only when it comes from your operating data, never from placeholders.
          </p>
          <ul className="mt-3 list-disc pl-5 text-sm" style={{ color: "var(--text-muted)" }}>
            {((latest.reasons as string[] | null) ?? []).map((r) => <li key={r}>{r}</li>)}
          </ul>
          <div className="mono mt-4 flex gap-4 text-xs">
            <Link href="/settings/quickbooks" className="underline">Connect QuickBooks</Link>
            <Link href="/jobs" className="underline">Record job costs</Link>
          </div>
        </Card>
      ) : (
        <>
          {/* HEADLINE */}
          <Card className="p-5" data-testid="valuation-headline">
            <div className="flex flex-wrap items-baseline gap-3">
              <span className="text-2xl font-semibold" style={{ color: "var(--text-body)" }}>
                ≈ {usdM(latest.valueLowCents!)} – {usdM(latest.valueHighCents!)}
              </span>
              {quarterDeltaCents != null && (
                <span className="mono text-sm" data-testid="quarter-delta"
                  style={{ color: quarterDeltaCents >= 0 ? "var(--accent-gold)" : "var(--text-muted)" }}>
                  {signedUsd(quarterDeltaCents)} this quarter
                </span>
              )}
              <span className="eyebrow" data-testid="quality-badge">
                {quality.real} measured · {quality.estimated} estimated · {quality.missing} unavailable
              </span>
              <Link href="#methodology" className="mono text-xs underline" style={{ color: "var(--text-muted)" }}>
                methodology
              </Link>
            </div>
            <p className="mono mt-2 text-xs" style={{ color: "var(--text-faint)" }}>
              SDE ≈ {usd(latest.sdeCents!)} · multiple {mult(latest.multipleLow!)} – {mult(latest.multipleHigh!)} · {CAPTION}
            </p>
          </Card>

          {/* VALUE BRIDGE */}
          <section data-testid="value-bridge">
            <div className="eyebrow mb-2">Value bridge — why the number is what it is</div>
            <Card className="p-4">
              <div className="space-y-2 text-sm">
                {adjustments.map((a) => (
                  <div key={a.key} className="flex items-start justify-between gap-4">
                    <span style={{ color: "var(--text-muted)" }}>{a.rationale}</span>
                    <span className="mono shrink-0" style={{ color: a.deltaHigh >= 0 && a.deltaLow >= 0 ? "var(--accent-gold)" : "var(--text-body)" }}>
                      {a.deltaLow >= 0 ? "+" : ""}{a.deltaLow.toFixed(2)} … {a.deltaHigh >= 0 ? "+" : ""}{a.deltaHigh.toFixed(2)}×
                    </span>
                  </div>
                ))}
                <div className="flex items-center justify-between border-t border-white/10 pt-2 font-semibold" style={{ color: "var(--text-body)" }}>
                  <span>Final multiple on SDE</span>
                  <span className="mono">{mult(latest.multipleLow!)} – {mult(latest.multipleHigh!)}</span>
                </div>
              </div>
            </Card>
          </section>

          {/* VALUE LEVERS */}
          {levers.length > 0 && (
            <section data-testid="value-levers">
              <div className="eyebrow mb-2">Value levers — the moves that raise the range</div>
              <div className="grid gap-3 sm:grid-cols-2">
                {levers.map((l) => (
                  <Card key={l.key} className="p-4">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-medium" style={{ color: "var(--text-body)" }}>{l.label}</span>
                      <span className="mono text-xs" style={{ color: "var(--accent-gold)" }}>
                        +{usdM(l.impactLowCents)}–{usdM(l.impactHighCents)} est.
                      </span>
                    </div>
                    <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>{l.why}</p>
                    <Link href={l.href} className="mono mt-2 inline-block text-xs underline" style={{ color: "var(--text-muted)" }}>
                      open the machinery →
                    </Link>
                  </Card>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {/* KPI STRIP — compact, all sourced, "—" for missing (never invented) */}
      <section data-testid="valuation-kpis">
        <div className="eyebrow mb-2">The inputs</div>
        <Card className="mono grid gap-2 p-4 text-xs sm:grid-cols-4" data-testid="kpi-strip">
          {kpis.map((k) => (
            <span key={k.label} style={{ color: "var(--text-muted)" }}>
              {k.label} <b style={{ color: "var(--text-body)" }}>{k.value}</b>
            </span>
          ))}
        </Card>
      </section>

      {/* METHODOLOGY */}
      <section id="methodology" data-testid="valuation-methodology">
        <div className="eyebrow mb-2">Methodology</div>
        <Card className="p-4 text-sm" style={{ color: "var(--text-muted)" }}>
          <p>
            Base multiple bands by revenue, then named adjustments — every +/− shown in the bridge above.
            Missing inputs widen the range as their own ledger entry; they are never guessed.
          </p>
          <p className="mono mt-2 text-xs" style={{ color: "var(--text-faint)" }}>
            version {latest.methodologyVersion} · {config.citations}
          </p>
          {quality.flags && (
            <div className="mono mt-3 grid gap-1 text-xs sm:grid-cols-2">
              {Object.entries(quality.flags).map(([k, v]) => (
                <span key={k} style={{ color: "var(--text-faint)" }}>{k}: {QUALITY_LABEL[v] ?? v}</span>
              ))}
            </div>
          )}
          <p className="mt-3 text-xs" style={{ color: "var(--text-faint)" }}>{CAPTION} Multiples and thresholds are Library config you can edit.</p>
        </Card>
      </section>
    </div>
  );
}
