"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { coverageWins, SHOWCASE, type EvidenceStatus } from "@savvy/core";
import type { ProofRow } from "@/lib/money-queries";

const STATUS_STYLE: Record<string, { color: string; glyph: string }> = {
  pass: { color: "var(--status-ok)", glyph: "✓" },
  fail: { color: "var(--status-error)", glyph: "✗" },
  stale: { color: "var(--status-skip)", glyph: "◐" },
  skip: { color: "var(--text-faint)", glyph: "–" },
};

function ago(iso: string): string {
  const hrs = Math.round((Date.now() - Date.parse(iso)) / 3_600_000);
  if (hrs < 1) return "just now";
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

const statusMap = (rows: ProofRow[]): Record<string, EvidenceStatus> =>
  Object.fromEntries(rows.map((r) => [r.checkKey, r.status as EvidenceStatus]));

/**
 * The nightly-proof coverage cells. SSRs the initial rows, then polls for live
 * status and celebrates ONLY a genuine earn (fail/stale → pass) with a toast +
 * a one-shot glow. `coverageWins` (unit-tested) is the honesty gate: a skip→pass
 * or an already-green cell never celebrates.
 */
export function ProofRows({ initial }: { initial: ProofRow[] }) {
  const [rows, setRows] = useState<ProofRow[]>(initial);
  const [glowing, setGlowing] = useState<Set<string>>(new Set());
  const prevStatus = useRef<Record<string, EvidenceStatus>>(statusMap(initial));

  useEffect(() => {
    let alive = true;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const tick = async () => {
      try {
        const res = await fetch("/api/coverage", { cache: "no-store" });
        if (!alive || !res.ok) return;
        const next = (await res.json()) as ProofRow[];
        const nextStatus = statusMap(next);
        const wins = coverageWins(prevStatus.current, nextStatus);
        prevStatus.current = nextStatus;
        setRows(next);
        if (wins.length > 0) {
          const labelOf = Object.fromEntries(next.map((r) => [r.checkKey, r.label]));
          setGlowing((g) => new Set([...g, ...wins]));
          for (const k of wins) toast.success(`${labelOf[k] ?? k} — coverage restored ✓`);
          timers.push(
            setTimeout(() => {
              if (alive) setGlowing((g) => new Set([...g].filter((k) => !wins.includes(k))));
            }, 3500),
          );
        }
      } catch {
        /* keep last known rows */
      }
    };
    const h = setInterval(tick, SHOWCASE.POLL_SECONDS * 1000);
    return () => {
      alive = false;
      clearInterval(h);
      for (const t of timers) clearTimeout(t);
    };
  }, []);

  return (
    <div className="mt-3">
      {rows.map((p) => {
        const s = STATUS_STYLE[p.status] ?? STATUS_STYLE.skip;
        const glow = glowing.has(p.checkKey) ? " anim-glow" : "";
        return (
          <div
            key={p.checkKey}
            className={`flex items-baseline justify-between gap-3 border-b py-2 last:border-b-0${glow}`}
            style={{ borderColor: "var(--border-panel)" }}
            data-testid="proof-row"
            data-status={p.status}
            data-checkkey={p.checkKey}
          >
            <div className="min-w-0">
              <span className="text-[13px]">{p.label}</span>
              <span className="mono ml-2 text-[10px]" style={{ color: "var(--text-faint)" }}>{p.checkKey}</span>
              {p.status === "fail" && p.message ? <div className="mono mt-0.5 text-[11px]" style={{ color: "var(--status-error)" }}>{p.message}</div> : null}
            </div>
            <span className="mono shrink-0 text-[11px]" style={{ color: s.color }} title={`ran ${ago(p.ranAt)}`}>
              {s.glyph} {p.status.toUpperCase()}{p.refCount > 0 ? ` · ${p.refCount}` : ""}
            </span>
          </div>
        );
      })}
    </div>
  );
}
