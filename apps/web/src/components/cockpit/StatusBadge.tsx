// Token-based status pill, shared across routes (replaces hardcoded bg-*-100 maps).
const STATUS_TONE: Record<string, string> = {
  // green — done/positive
  paid: "var(--status-ok)", done: "var(--status-ok)", accepted: "var(--status-ok)",
  approved: "var(--status-ok)", complete: "var(--status-ok)", ok: "var(--status-ok)",
  // amber — needs attention
  partial: "var(--status-skip)", overdue: "var(--status-skip)", skipped: "var(--status-skip)",
  no_show: "var(--status-skip)",
  // red — negative/terminal
  void: "var(--status-error)", voided: "var(--status-error)", canceled: "var(--status-error)",
  declined: "var(--status-error)", error: "var(--status-error)",
  // gold — in flight
  sent: "var(--accent-gold)", scheduled: "var(--accent-gold)",
  // faint — idle/draft
  draft: "var(--text-faint)", upcoming: "var(--text-faint)", pending: "var(--text-faint)",
};

export function StatusBadge({ status }: { status: string }) {
  const c = STATUS_TONE[status] ?? "var(--text-muted)";
  return (
    <span
      className="mono rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider"
      style={{ color: c, background: `color-mix(in srgb, ${c} 14%, transparent)`, border: `1px solid color-mix(in srgb, ${c} 35%, transparent)` }}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}
