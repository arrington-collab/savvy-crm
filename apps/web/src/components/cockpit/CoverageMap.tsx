import { Card } from "@/components/ui/card";
import { summarizeTenantCoverage, type TenantRollupLite } from "@savvy/core";

function ago(d: Date): string {
  const mins = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

const SEGMENTS = [
  { key: "green", label: "Green", color: "var(--status-ok)" },
  { key: "amber", label: "Amber", color: "var(--status-skip)" },
  { key: "red", label: "Red", color: "var(--status-error)" },
  { key: "gray", label: "Unproven", color: "var(--text-faint)" },
] as const;

/**
 * The Coverage Map — "empire coverage": how much of the 212-task operation is
 * fully automated AND proven green, read from tenant_ops_rollup. Read-only; the
 * display math lives in the tested pure summarizeTenantCoverage.
 */
export function CoverageMap({ rollup }: { rollup: TenantRollupLite }) {
  const c = summarizeTenantCoverage(rollup);

  return (
    <Card className="p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="font-semibold">Empire Coverage</h2>
        <span className="mono text-[11px]" style={{ color: "var(--text-faint)" }}>
          {c.computedAt ? `as of ${ago(c.computedAt)}` : ""}
        </span>
      </div>

      {!c.hasData ? (
        <p className="mt-3 text-sm" style={{ color: "var(--text-faint)" }}>
          Coverage populates after the first nightly sweep runs the evidence checks.
        </p>
      ) : (
        <>
          <div className="mt-3 flex items-end gap-2">
            <span className="mono text-3xl font-semibold tracking-tight text-accent-gold">
              {c.fullAutoGreen}
              <span style={{ color: "var(--text-faint)" }}>/{c.totalTasks}</span>
            </span>
            <span className="pb-1 text-sm" style={{ color: "var(--text-muted)" }}>
              tasks fully automated &amp; proven ({c.coveragePct}%)
            </span>
          </div>

          {/* Segmented status bar — the "map" of where the operation stands. */}
          <div className="mt-3 flex h-2.5 w-full overflow-hidden rounded-full" style={{ background: "var(--border-panel)" }}>
            {SEGMENTS.map((s) => {
              const n = c[s.key];
              return n > 0 ? (
                <div key={s.key} title={`${s.label}: ${n}`} style={{ width: `${(n / c.totalTasks) * 100}%`, background: s.color }} />
              ) : null;
            })}
          </div>

          <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
            {SEGMENTS.map((s) => (
              <li key={s.key} className="flex items-center gap-1.5 text-[13px]" style={{ color: "var(--text-muted)" }}>
                <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                {s.label}
                <span className="mono" style={{ color: "var(--text-body)" }}>{c[s.key]}</span>
              </li>
            ))}
          </ul>

          <div className="mono mt-3 text-[12px]" style={{ color: "var(--text-faint)" }}>
            {c.openExceptions} open · {c.jobs30d} jobs 30d · {Math.round(c.founderMinutes30d)}m founder-time 30d
          </div>
        </>
      )}
    </Card>
  );
}
