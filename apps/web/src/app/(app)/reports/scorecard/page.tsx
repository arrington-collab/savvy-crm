import {
  weeklyScorecard, withTenant, eq, and, isNull, rebuildWeek,
} from "@savvy/db";
import { businessDateOf, weekStartOf, MEASURABLE_KEYS, OWNER_DEFAULTS } from "@savvy/command-center";
import type { MetricValue } from "@savvy/command-center";
import { getTenantId } from "@/lib/tenant";
import { fmtUsd } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/cockpit/PageHeader";
import { Sparkline } from "@/components/scorecard/Sparkline";

export const dynamic = "force-dynamic";

// D4-7: the EOS weekly scorecard page. Logic layer (D4-6) already did the
// hard part — `buildScorecard`/`rebuildWeek` produce/persist one
// `weekly_scorecard` row per MEASURABLE_KEYS entry, off-track sorted first,
// pending metrics carrying a reason instead of a fake 0. This file is render
// only: read the current week's persisted rows (regenerating on-demand if
// they don't exist yet, same "compute → persist → read" recipe
// api/flash/route.ts uses for its on-demand regen), then lay them out as the
// classic EOS scorecard table.

type ScorecardDbRow = Awaited<ReturnType<typeof getScorecardRows>>[number];

async function getScorecardRows(tenantId: string, weekStart: string) {
  return withTenant(tenantId, (tx) =>
    tx.select().from(weeklyScorecard).where(and(
      eq(weeklyScorecard.tenantId, tenantId),
      eq(weeklyScorecard.weekStart, weekStart),
      isNull(weeklyScorecard.locationId), // company-wide rollup only (no per-location scorecards yet)
    )));
}

// Mirrors buildScorecard's own (unexported) onTrackRank — off-track first
// (needs attention now), pending/no-goal second, on-track last. Duplicated
// here (not imported) because a SELECT from Postgres has no guaranteed row
// order — the page must re-sort itself rather than trust insertion order.
function trackRank(onTrack: boolean | null): number {
  if (onTrack === false) return 0;
  if (onTrack === null) return 1;
  return 2;
}

function formatCount(n: number): string {
  return n.toLocaleString();
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatPct(fraction: number): string {
  return `${(fraction * 100).toFixed(0)}%`;
}

// margin.avg_pct is stored 0-100 already (not a 0-1 fraction — see
// DEFAULT_GOALS' comment in scorecard-goals.ts), so it gets its own formatter.
function formatMarginPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

function formatStars(n: number): string {
  return `${n.toFixed(1)}★`;
}

interface MetricMeta {
  label: string;
  format: (n: number) => string;
}

// One label + one formatter per MEASURABLE_KEYS entry (spec Appendix A.2)
// — kept as a lookup table, not scattered conditionals, so adding a new
// measurable to the logic layer only needs one new entry here.
const METRIC_META: Record<string, MetricMeta> = {
  "leads.new": { label: "New leads", format: formatCount },
  "speed.median_seconds": { label: "Median response time", format: formatDuration },
  "speed.pct_under_sla": { label: "% first-touch under SLA", format: formatPct },
  "appts.set": { label: "Appointments set", format: formatCount },
  "appts.no_show_rate": { label: "No-show rate", format: formatPct },
  "contracts.count": { label: "Contracts signed", format: formatCount },
  "contracts.value": { label: "Contract value", format: fmtUsd },
  "close_rate.cohort": { label: "Close rate (cohort)", format: formatPct },
  "close_rate.activity": { label: "Close rate (activity basis)", format: formatPct },
  "revenue.invoiced": { label: "Revenue invoiced", format: fmtUsd },
  "cash.collected": { label: "Cash collected", format: fmtUsd },
  "margin.avg_pct": { label: "Avg margin", format: formatMarginPct },
  "reviews.count": { label: "Reviews posted", format: formatCount },
  "reviews.avg_stars": { label: "Avg star rating", format: formatStars },
  "exceptions.open": { label: "Open exceptions", format: formatCount },
};

function metaFor(metricKey: string): MetricMeta {
  return METRIC_META[metricKey] ?? { label: metricKey, format: formatCount };
}

function formatGoal(goal: ScorecardDbRow["goal"], format: (n: number) => string): string {
  if (!goal) return "—";
  return `${goal.direction === "gte" ? "≥" : "≤"} ${format(goal.target)}`;
}

function formatDateTime(d: Date): string {
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
}

function formatWeekLabel(weekStart: string): string {
  const [y, m, d] = weekStart.split("-").map(Number);
  const monday = new Date(Date.UTC(y!, m! - 1, d!));
  const sunday = new Date(Date.UTC(y!, m! - 1, d! + 6));
  const fmt = (dt: Date) => dt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${fmt(monday)}–${fmt(sunday)}`;
}

// Off-track = red (needs attention), on-track = green (confirmed fine),
// null (pending value or no goal configured) = neutral faint — never a red
// badge for something that simply can't be judged yet (§7).
function TrackBadge({ onTrack }: { onTrack: boolean | null }) {
  const tone = onTrack === true ? "var(--status-ok)" : onTrack === false ? "var(--status-error)" : "var(--text-faint)";
  const label = onTrack === true ? "On track" : onTrack === false ? "Off track" : "—";
  return (
    <span
      className="mono rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider"
      style={{
        color: tone,
        background: `color-mix(in srgb, ${tone} 14%, transparent)`,
        border: `1px solid color-mix(in srgb, ${tone} 35%, transparent)`,
      }}
      data-testid="track-badge"
    >
      {label}
    </span>
  );
}

export default async function ScorecardPage() {
  const tenantId = await getTenantId();
  const weekStart = weekStartOf(businessDateOf(new Date()));

  let persisted = await getScorecardRows(tenantId, weekStart);
  if (persisted.length === 0) {
    // No rows yet for this week (first view, cron hasn't run) — regenerate
    // on-demand from the event log, same recipe api/flash/route.ts uses.
    await rebuildWeek(tenantId, weekStart);
    persisted = await getScorecardRows(tenantId, weekStart);
  }

  const rows = [...persisted].sort((a, b) => {
    const rankDiff = trackRank(a.onTrack) - trackRank(b.onTrack);
    if (rankDiff !== 0) return rankDiff;
    return MEASURABLE_KEYS.indexOf(a.metricKey) - MEASURABLE_KEYS.indexOf(b.metricKey);
  });

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Reports" title="Weekly scorecard" />
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        As of {formatDateTime(new Date())} · based on week of {formatWeekLabel(weekStart)} ({weekStart}). Off-track
        measurables are pinned to the top. Goals marked <span className="italic">placeholder</span> are sensible
        stand-ins, not real targets Brett/Scott have set yet.
      </p>

      <Card className="p-4" data-testid="scorecard-table">
        {rows.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-faint)" }}>No scorecard data yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="eyebrow text-left">
                <th className="py-1">Measurable</th>
                <th>Owner</th>
                <th>Goal</th>
                <th>This week</th>
                <th>13-week trend</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody style={{ color: "var(--text-body)" }}>
              {rows.map((row) => {
                const meta = metaFor(row.metricKey);
                // Defensive: the column is nullable at the DB level (schema.ts),
                // even though buildScorecard always writes a real MetricValue —
                // never render a bare 0/blank for a row that somehow has none.
                const value: MetricValue = row.value ?? { status: "pending", reason: "not computed" };
                const isPlaceholder = row.goal?.isPlaceholder ?? true;

                return (
                  <tr key={row.metricKey} data-testid={`row-${row.metricKey}`}>
                    <td className="py-1">{meta.label}</td>
                    <td>{OWNER_DEFAULTS[row.metricKey] ?? "Unassigned"}</td>
                    <td>
                      {formatGoal(row.goal, meta.format)}
                      {isPlaceholder && (
                        <span className="ml-1 text-[10px] italic" style={{ color: "var(--text-faint)" }}>
                          placeholder
                        </span>
                      )}
                    </td>
                    <td>
                      {value.status === "ok" ? (
                        meta.format(value.value)
                      ) : (
                        <span style={{ color: "var(--text-faint)" }}>— {value.reason}</span>
                      )}
                    </td>
                    <td>
                      <Sparkline values={row.priorWeeks} />
                    </td>
                    <td>
                      <TrackBadge onTrack={row.onTrack} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
