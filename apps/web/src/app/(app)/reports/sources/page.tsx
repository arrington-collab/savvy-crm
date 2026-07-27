import {
  getDailyBySourceRange, rebuildWeek, resolveContractSignings, withTenant, eq, and, gte, lte, lead,
} from "@savvy/db";
import {
  businessDateOf, weekStartOf, weekDates, denverWeekWindow, foldSourceWeek,
  closeRateCohort, UNKNOWN_SOURCE, ok, pending,
} from "@savvy/command-center";
import type { MetricValue, SourceWeekRow } from "@savvy/command-center";
import { getTenantId } from "@/lib/tenant";
import { fmtUsd } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/cockpit/PageHeader";

export const dynamic = "force-dynamic";

// D4-8: per-source weekly dashboard. Reuses the D4-4 dimensional daily rows
// (`daily_metrics_by_source`, folded by `foldSourceWeek` in
// `@savvy/command-center`) for volume/appts/revenue, plus D4-5's
// `closeRateCohort` — recomputed here per source the same way `rebuildWeek`
// computes it company-wide: leads CREATED this week (from `lead`, grouped by
// its own `source` column) against ALL-TIME contract signings resolved via
// `resolveContractSignings`'s honesty-gated job/customer join. Cost/ROI is
// never imputed (§8.8) — a source with no `costCents` on any of its daily
// rows this week renders "no cost data", not a fabricated $0 spend or a fake
// ROI multiple.

function formatCount(n: number): string {
  return n.toLocaleString();
}

function formatPct(fraction: number): string {
  return `${(fraction * 100).toFixed(0)}%`;
}

function formatRatio(n: number): string {
  return `${n.toFixed(1)}x`;
}

function renderMetric(value: MetricValue, format: (n: number) => string) {
  if (value.status === "ok") return format(value.value);
  return <span style={{ color: "var(--text-faint)" }}>— {value.reason}</span>;
}

function sourceLabel(source: string): string {
  return source === UNKNOWN_SOURCE ? "Unknown source" : source;
}

async function getLeadsCreatedInWeek(tenantId: string, weekStart: string) {
  const { startUtc, endUtc } = denverWeekWindow(weekStart);
  return withTenant(tenantId, (tx) =>
    tx.select({ id: lead.id, source: lead.source, createdAt: lead.createdAt }).from(lead)
      .where(and(eq(lead.tenantId, tenantId), gte(lead.createdAt, startUtc), lte(lead.createdAt, endUtc))));
}

interface SourceRow extends SourceWeekRow {
  cohort: MetricValue;
  cohortMaturing: boolean;
  cohortAgeDays: number;
  costPerLeadCents: number | null;
  roi: number | null;
}

export default async function SourcesPage() {
  const tenantId = await getTenantId();
  const weekStart = weekStartOf(businessDateOf(new Date()));
  const dates = weekDates(weekStart);

  let daily = await getDailyBySourceRange(tenantId, dates[0]!, dates[6]!);
  if (daily.length === 0) {
    // No rows yet for this week (first view, cron hasn't run) — regenerate
    // on-demand from the event log, same recipe the scorecard page uses.
    await rebuildWeek(tenantId, weekStart);
    daily = await getDailyBySourceRange(tenantId, dates[0]!, dates[6]!);
  }

  const folded = foldSourceWeek(daily);

  const [leadsCreatedInWeek, contractsAsOfNow] = await Promise.all([
    getLeadsCreatedInWeek(tenantId, weekStart),
    resolveContractSignings(tenantId),
  ]);
  const now = new Date();

  const rows: SourceRow[] = folded.map((row): SourceRow => {
    const sourceLeads = leadsCreatedInWeek
      .filter((l) => (l.source ?? UNKNOWN_SOURCE) === row.source)
      .map((l) => ({ leadId: l.id, createdAt: l.createdAt }));

    const cohortRaw = closeRateCohort({ leadsCreatedInWeek: sourceLeads, contractsAsOfNow, now, weekStart });
    const cohort: MetricValue = sourceLeads.length === 0
      ? pending("no leads created this week")
      : ok(cohortRaw.rate);

    const costPerLeadCents = row.costCents != null && row.leads > 0 ? row.costCents / row.leads : null;
    const roi = row.costCents != null && row.costCents > 0 ? row.contractValueCents / row.costCents : null;

    return { ...row, cohort, cohortMaturing: cohortRaw.maturing, cohortAgeDays: cohortRaw.cohortAgeDays, costPerLeadCents, roi };
  }).sort((a, b) => b.leads - a.leads);

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Reports" title="Source scorecard" />
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        Week of {weekStart}. Close rate is <span className="italic">cohort</span> basis — of the leads CREATED this
        week, the share that have signed as of right now — not a &ldquo;conversion&rdquo; snapshot. A young cohort
        is still maturing; give it time before trusting the number. Cost-per-lead / ROI only render where a source
        has real spend data on file — never a guessed 0.
      </p>

      <Card className="p-4" data-testid="sources-table">
        {rows.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-faint)" }}>No source activity yet this week.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="eyebrow text-left">
                <th className="py-1">Source</th>
                <th>Leads</th>
                <th>Appt rate</th>
                <th>Close rate (cohort)</th>
                <th>Revenue</th>
                <th>Cost / lead</th>
                <th>ROI</th>
              </tr>
            </thead>
            <tbody style={{ color: "var(--text-body)" }}>
              {rows.map((row) => {
                const isUnknown = row.source === UNKNOWN_SOURCE;
                return (
                  <tr key={row.source} data-testid={`row-${row.source}`}>
                    <td className="py-1">
                      {isUnknown ? (
                        <span className="italic" style={{ color: "var(--text-faint)" }}>{sourceLabel(row.source)}</span>
                      ) : (
                        sourceLabel(row.source)
                      )}
                    </td>
                    <td>{formatCount(row.leads)}</td>
                    <td>{renderMetric(row.apptRate, formatPct)}</td>
                    <td>
                      {renderMetric(row.cohort, formatPct)}
                      {row.cohort.status === "ok" && row.cohortMaturing && (
                        <span className="ml-1 text-[10px] italic" style={{ color: "var(--text-faint)" }}>
                          maturing · {row.cohortAgeDays}d old
                        </span>
                      )}
                    </td>
                    <td>{fmtUsd(row.contractValueCents)}</td>
                    <td>
                      {row.costPerLeadCents != null ? (
                        fmtUsd(row.costPerLeadCents)
                      ) : (
                        <span style={{ color: "var(--text-faint)" }}>no cost data</span>
                      )}
                    </td>
                    <td>
                      {row.roi != null ? (
                        formatRatio(row.roi)
                      ) : (
                        <span style={{ color: "var(--text-faint)" }}>no cost data</span>
                      )}
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
