import {
  getDailyByRepRange, rebuildWeek, withTenant, eq, and, inArray, user,
} from "@savvy/db";
import {
  businessDateOf, weekStartOf, weekDates, foldRepWeek, rankReps, MIN_LEADS_FOR_RANK,
} from "@savvy/command-center";
import type { MetricValue, RankedRepRow } from "@savvy/command-center";
import { getTenantId } from "@/lib/tenant";
import { fmtUsd } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/cockpit/PageHeader";

export const dynamic = "force-dynamic";

// D4-8: per-rep weekly dashboard. Reuses the D4-4 dimensional daily rows
// (`daily_metrics_by_rep`, via `getDailyByRepRange`) rather than re-scanning
// the event log — same "compute → persist → read" recipe as the D4-7
// scorecard page, just folded across a different dimension. The fold +
// ranking logic lives in `@savvy/command-center`'s `dimensional-fold.ts`
// (pure, unit-tested) — this file is render only.

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

// Same 0-100 (not 0-1) convention scorecard/page.tsx's margin.avg_pct uses —
// avgMarginPct here is folded from the same estimate.approved marginPct events.
function formatMarginPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

function renderMetric(value: MetricValue, format: (n: number) => string) {
  if (value.status === "ok") return format(value.value);
  return <span style={{ color: "var(--text-faint)" }}>— {value.reason}</span>;
}

async function getRepNames(tenantId: string, repIds: string[]): Promise<Map<string, string>> {
  if (repIds.length === 0) return new Map();
  const rows = await withTenant(tenantId, (tx) =>
    tx.select({ id: user.id, name: user.name }).from(user)
      .where(and(eq(user.tenantId, tenantId), inArray(user.id, repIds))));
  return new Map(rows.map((r) => [r.id, r.name]));
}

// Sort order for the table: ranked reps first (by rank asc), then
// insufficient-volume reps (by revenue desc, since they still have SOME
// signal, just not enough to rank on), then the Unassigned bucket always
// last — it isn't a rep and should never compete for the top of the board.
function tableRank(row: RankedRepRow): number {
  if (row.repId === null) return 2;
  if (row.rank !== null) return 0;
  return 1;
}

export default async function RepsPage() {
  const tenantId = await getTenantId();
  const weekStart = weekStartOf(businessDateOf(new Date()));
  const dates = weekDates(weekStart);

  let daily = await getDailyByRepRange(tenantId, dates[0]!, dates[6]!);
  if (daily.length === 0) {
    // No rows yet for this week (first view, cron hasn't run) — regenerate
    // on-demand from the event log, same recipe the scorecard page uses.
    await rebuildWeek(tenantId, weekStart);
    daily = await getDailyByRepRange(tenantId, dates[0]!, dates[6]!);
  }

  const folded = foldRepWeek(daily);
  const ranked = rankReps(folded).sort((a, b) => {
    const rankDiff = tableRank(a) - tableRank(b);
    if (rankDiff !== 0) return rankDiff;
    if (a.rank !== null && b.rank !== null) return a.rank - b.rank;
    return b.contractValueCents - a.contractValueCents;
  });

  const repIds = ranked.map((r) => r.repId).filter((id): id is string => id !== null);
  const namesById = await getRepNames(tenantId, repIds);

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Reports" title="Rep scorecard" />
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        Week of {weekStart}. Reps need at least {MIN_LEADS_FOR_RANK} leads this week to be ranked (
        <span className="italic">placeholder</span> threshold, pending Brett/Scott confirmation) — below that, the
        row shows &ldquo;insufficient volume&rdquo; instead of a misleadingly precise rank. The Unassigned row is
        unattributed activity, not a real rep, and is never ranked.
      </p>

      <Card className="p-4" data-testid="reps-table">
        {ranked.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-faint)" }}>No rep activity yet this week.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="eyebrow text-left">
                <th className="py-1">Rank</th>
                <th>Rep</th>
                <th>Leads</th>
                <th>Median speed (approx.)</th>
                <th>% under SLA</th>
                <th>Appts set</th>
                <th>No-show rate</th>
                <th>Contracts</th>
                <th>Revenue</th>
                <th>Avg margin</th>
              </tr>
            </thead>
            <tbody style={{ color: "var(--text-body)" }}>
              {ranked.map((row) => {
                const isUnassigned = row.repId === null;
                const label = isUnassigned ? "Unassigned" : namesById.get(row.repId!) ?? row.repId!;
                return (
                  <tr key={row.repId ?? "unassigned"} data-testid={isUnassigned ? "row-unassigned" : `row-${row.repId}`}>
                    <td className="py-1">
                      {row.rank !== null ? (
                        row.rank
                      ) : isUnassigned ? (
                        <span style={{ color: "var(--text-faint)" }}>—</span>
                      ) : (
                        <span className="text-xs italic" style={{ color: "var(--text-faint)" }}>
                          insufficient volume — not ranked
                        </span>
                      )}
                    </td>
                    <td>
                      {isUnassigned ? (
                        <span className="italic" style={{ color: "var(--text-faint)" }} data-testid="unassigned-label">
                          Unassigned <span className="text-xs">(unattributed activity)</span>
                        </span>
                      ) : (
                        label
                      )}
                    </td>
                    <td>{formatCount(row.leads)}</td>
                    <td>{renderMetric(row.speedMedianSeconds, formatDuration)}</td>
                    <td>{renderMetric(row.pctUnderSla, formatPct)}</td>
                    <td>{formatCount(row.apptsSet)}</td>
                    <td>{renderMetric(row.noShowRate, formatPct)}</td>
                    <td>{formatCount(row.contracts)}</td>
                    <td>{fmtUsd(row.contractValueCents)}</td>
                    <td>{renderMetric(row.avgMarginPct, formatMarginPct)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      {ranked.length > 0 && (
        <p className="text-xs" style={{ color: "var(--text-faint)" }}>
          Median speed is an <span className="italic">approximation</span>: a firstTouches-weighted average of each
          day&rsquo;s median response time, not the true median across the whole week&rsquo;s raw response times —
          the daily rows store only a per-day median, not individual latencies.
        </p>
      )}
    </div>
  );
}
