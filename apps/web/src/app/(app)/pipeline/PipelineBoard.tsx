"use client";
import { useState } from "react";
import Link from "next/link";
import { PIPELINE_COLUMNS, cardMatchesFilter, type PipelineColumn, type PipelineFilter } from "@savvy/core";
import type { PipelineBoardCard, PipelineBoardData } from "@/lib/pipeline-queries";

const COLUMN_LABEL: Record<PipelineColumn, string> = {
  lead: "Lead", inspected: "Inspected", estimate: "Estimate", approved: "Approved",
  production: "Production", invoiced: "Invoiced", paid: "Paid",
};
// Which job-stage's avg-days to show in each column header (getStageVelocity is stage-keyed).
const COLUMN_VELOCITY_STAGE: Record<PipelineColumn, string> = {
  lead: "lead", inspected: "inspected", estimate: "estimate", approved: "approved",
  production: "production", invoiced: "billing", paid: "complete",
};

const FILTERS: { key: PipelineFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "stuck", label: "Stuck" },
  { key: "waiting_human", label: "Waiting on human" },
  { key: "claims", label: "Claims" },
  { key: "over_25k", label: "$25k+" },
];

function usdK(cents: number | null): string {
  if (cents == null) return "—";
  const k = cents / 100000;
  return k >= 1 ? `$${k.toFixed(1)}k` : (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

export function PipelineBoard({ data }: { data: PipelineBoardData }) {
  const [filter, setFilter] = useState<PipelineFilter>("all");
  const all = PIPELINE_COLUMNS.flatMap((c) => data.columns[c]);
  const match = (card: PipelineBoardCard) =>
    cardMatchesFilter({ isStuck: card.isStuck, isClaim: card.isClaim, valueCents: card.valueCents, waitingOnHuman: card.waitingIsHuman }, filter);

  const count = (f: PipelineFilter) => all.filter((c) => cardMatchesFilter({ isStuck: c.isStuck, isClaim: c.isClaim, valueCents: c.valueCents, waitingOnHuman: c.waitingIsHuman }, f)).length;

  return (
    <div data-testid="pipeline-board">
      <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="Pipeline filters">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            data-testid={`chip-${f.key}`}
            aria-pressed={filter === f.key}
            onClick={() => setFilter(f.key)}
            className={
              "mono rounded-full border px-3 py-1 text-[11px] transition-colors " +
              (filter === f.key
                ? "border-[var(--accent-040)] bg-[var(--accent-010)] text-accent-gold"
                : "border-[var(--border-panel)] text-[var(--text-muted)] hover:text-[var(--text-body)]")
            }
          >
            {f.label} · {count(f.key)}
          </button>
        ))}
      </div>

      <div className="flex gap-3 overflow-x-auto pb-3" data-testid="pipeline-columns">
        {PIPELINE_COLUMNS.map((col) => {
          const cards = data.columns[col].filter(match);
          const gross = cards.reduce((a, c) => a + (c.valueCents ?? 0), 0);
          const avgDays = data.velocityDays[COLUMN_VELOCITY_STAGE[col]];
          return (
            <section key={col} data-testid={`pcol-${col}`} className="min-w-[220px] flex-1 rounded-lg p-2.5" style={{ background: "var(--bg-elevated, rgba(255,255,255,0.015))", border: "1px solid var(--border-panel)" }}>
              <div className="mb-2 flex items-baseline justify-between px-1">
                <span className="mono flex items-center gap-1.5 text-[11px] uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--accent-gold)" }} />
                  {COLUMN_LABEL[col]}
                </span>
                <span className="mono text-[10px]" style={{ color: "var(--text-faint)" }} data-testid={`pcol-${col}-meta`}>
                  {cards.length}{gross > 0 ? ` · ${usdK(gross)}` : ""}{avgDays ? ` · ${avgDays}d avg` : ""}
                </span>
              </div>
              <div className="space-y-2">
                {cards.map((c) => (
                  <Link
                    key={`${c.kind}-${c.id}`}
                    href={c.href}
                    data-testid="pipeline-card"
                    data-column={col}
                    data-kind={c.kind}
                    data-stuck={c.isStuck ? "true" : undefined}
                    className="block rounded-md p-2.5 transition-colors"
                    style={{ background: "var(--surface-panel)", border: `1px solid ${c.isStuck ? "var(--status-error)" : "var(--border-panel)"}` }}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="truncate text-[13px] font-semibold">{c.name}</span>
                      <span className="mono shrink-0 text-[11px] text-accent-gold">{usdK(c.valueCents)}</span>
                    </div>
                    <div className="truncate text-[11px]" style={{ color: "var(--text-faint)" }}>{c.address}</div>
                    <div className="mono mt-2 flex items-center gap-1.5 text-[10px] leading-relaxed" style={{ color: c.isStuck ? "var(--status-error)" : "var(--text-muted)" }} data-testid="waiting-on">
                      <span style={{ color: "var(--text-faint)" }}>waiting on:</span>
                      <span>{c.waitingLabel}</span>
                      <span style={{ color: c.waitingIsHuman ? "var(--accent-gold)" : "var(--text-faint)" }}>· {c.waitingOwner}</span>
                    </div>
                    {c.isClaim ? <span className="eyebrow mt-1 inline-block" style={{ fontSize: "0.5rem", color: "var(--text-faint)" }}>claim</span> : null}
                  </Link>
                ))}
                {cards.length === 0 ? <p className="px-1 py-2 text-[11px]" style={{ color: "var(--text-faint)" }}>—</p> : null}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
