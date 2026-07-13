"use client";
import type { FeedRow } from "@/lib/command-center-queries";

function statusColor(s: string) {
  if (s === "error") return "var(--status-error)";
  if (s === "skipped") return "var(--status-skip)";
  if (s === "ok") return "var(--status-ok)";
  return "var(--text-faint)";
}
function ago(d: string | Date) {
  const mins = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 24 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`;
}

export function ActivityRow({ r }: { r: FeedRow }) {
  const c = statusColor(r.status);
  return (
    <li
      data-testid="activity-row"
      className="flex items-center gap-3 rounded-lg px-2 py-2 text-sm"
      style={{ borderBottom: "1px solid var(--border-panel)" }}
    >
      <span className="truncate" style={{ color: "var(--text-body)" }}>{r.verb}</span>
      {r.target ? (
        <span className="truncate text-[13px]" style={{ color: "var(--text-muted)" }}>· {r.target}</span>
      ) : null}
      <span className="ml-auto flex items-center gap-2">
        <span
          className="mono rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider"
          style={{ color: c, background: `color-mix(in srgb, ${c} 14%, transparent)`, border: `1px solid color-mix(in srgb, ${c} 35%, transparent)` }}
        >
          {r.status}
        </span>
        <span className="mono w-16 text-right text-[11px]" style={{ color: "var(--text-faint)" }}>{ago(r.startedAt)}</span>
      </span>
    </li>
  );
}
