import {
  getDailyByLocationRange, rebuildWeek,
} from "@savvy/db";
import {
  businessDateOf, weekStartOf, weekDates, foldLocationWeek, sumLocationWeeks,
} from "@savvy/command-center";
import type { MetricValue, LocationWeekRow, CompanyLocationTotal } from "@savvy/command-center";
import { getTenantId } from "@/lib/tenant";
import { fmtUsd } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/cockpit/PageHeader";

export const dynamic = "force-dynamic";

// D4-9: the location "empire view" (spec §6d/§8.12) — company totals +
// per-location breakdown + a side-by-side comparison of the same
// measurables, so Arrington can compare markets without visiting them. Reuses
// the D4-4 dimensional daily rows (`daily_metrics_by_location`, via
// `getDailyByLocationRange`) folded to the week by `foldLocationWeek`
// (@savvy/command-center, pure, unit-tested) — same "compute -> persist ->
// read" recipe as the D4-7/D4-8 pages, just folded across the location
// dimension. With a single location on file today this renders one location
// row + a company total that equals it exactly — that's expected, NOT a sign
// something's missing; nothing here needs to change when location #2 shows up.

function formatCount(n: number): string {
  return n.toLocaleString();
}

function formatPct(fraction: number): string {
  return `${(fraction * 100).toFixed(0)}%`;
}

function renderMetric(value: MetricValue, format: (n: number) => string) {
  if (value.status === "ok") return format(value.value);
  return <span style={{ color: "var(--text-faint)" }}>— {value.reason}</span>;
}

// No `location` entity table exists yet (design doc: "every aggregate
// carries locationId, nullable until locations modeled") — there is nowhere
// to look up a human-friendly name. Render what we actually have (the raw id,
// truncated) rather than inventing a label that isn't backed by data.
function locationLabel(locationId: string | null): string {
  if (locationId === null) return "Unattributed";
  return `Location ${locationId.slice(0, 8)}`;
}

interface DisplayRow {
  key: string;
  label: string;
  isUnattributed: boolean;
  leads: number;
  appointmentsSet: number;
  noShowRate: MetricValue;
  contracts: number;
  contractValueCents: number;
  invoicedCents: number;
  cashCollectedCents: number;
  reviewsPosted: number;
  avgStars: MetricValue;
  avgMarginPct: MetricValue;
}

function toDisplayRow(key: string, label: string, isUnattributed: boolean, row: LocationWeekRow | CompanyLocationTotal): DisplayRow {
  return {
    key, label, isUnattributed,
    leads: row.leads,
    appointmentsSet: row.appointmentsSet,
    noShowRate: row.noShowRate,
    contracts: row.contracts,
    contractValueCents: row.contractValueCents,
    invoicedCents: row.invoicedCents,
    cashCollectedCents: row.cashCollectedCents,
    reviewsPosted: row.reviewsPosted,
    avgStars: row.avgStars,
    avgMarginPct: row.avgMarginPct,
  };
}

function TableRows({ rows }: { rows: DisplayRow[] }) {
  return (
    <>
      {rows.map((row) => (
        <tr key={row.key} data-testid={`row-${row.key}`}>
          <td className="py-1">
            {row.isUnattributed ? (
              <span className="italic" style={{ color: "var(--text-faint)" }}>{row.label}</span>
            ) : (
              row.label
            )}
          </td>
          <td>{formatCount(row.leads)}</td>
          <td>{formatCount(row.appointmentsSet)}</td>
          <td>{renderMetric(row.noShowRate, formatPct)}</td>
          <td>{formatCount(row.contracts)}</td>
          <td>{fmtUsd(row.contractValueCents)}</td>
          <td>{fmtUsd(row.invoicedCents)}</td>
          <td>{fmtUsd(row.cashCollectedCents)}</td>
          <td>{formatCount(row.reviewsPosted)}</td>
        </tr>
      ))}
    </>
  );
}

export default async function LocationsPage() {
  const tenantId = await getTenantId();
  const weekStart = weekStartOf(businessDateOf(new Date()));
  const dates = weekDates(weekStart);

  let daily = await getDailyByLocationRange(tenantId, dates[0]!, dates[6]!);
  if (daily.length === 0) {
    // No rows yet for this week (first view, cron hasn't run) — regenerate
    // on-demand from the event log, same recipe the other report pages use.
    await rebuildWeek(tenantId, weekStart);
    daily = await getDailyByLocationRange(tenantId, dates[0]!, dates[6]!);
  }

  const folded = foldLocationWeek(daily.map((r) => ({ locationId: r.locationId, metrics: r.metrics })));
  const companyTotal = sumLocationWeeks(folded);

  // Real locations first (by revenue desc — the empire-view "who's carrying
  // the map" read), the unattributed bucket always last: it isn't a location.
  const locationRows = [...folded].sort((a, b) => {
    if (a.locationId === null) return 1;
    if (b.locationId === null) return -1;
    return b.contractValueCents - a.contractValueCents;
  });

  const displayRows: DisplayRow[] = locationRows.map((row) =>
    toDisplayRow(row.locationId ?? "unattributed", locationLabel(row.locationId), row.locationId === null, row));

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Reports" title="Location empire view" />
      <p className="text-sm" style={{ color: "var(--text-muted)" }}>
        Week of {weekStart}. Company total is the sum of every location row below (unattributed activity included) —
        never a separately-computed number. With a single location on file today this renders one location row plus a
        company total that matches it exactly; nothing here needs to change when a second location is added. Location
        names aren&rsquo;t modeled yet, so rows are labeled by their raw location id.
      </p>

      <Card className="p-4" data-testid="company-total-card">
        <p className="eyebrow mb-2">Company total</p>
        {folded.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-faint)" }}>No activity recorded yet this week.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="eyebrow text-left">
                <th className="py-1">Scope</th>
                <th>Leads</th>
                <th>Appts set</th>
                <th>No-show rate</th>
                <th>Contracts</th>
                <th>Contract value</th>
                <th>Invoiced</th>
                <th>Cash collected</th>
                <th>Reviews</th>
              </tr>
            </thead>
            <tbody style={{ color: "var(--text-body)" }}>
              <TableRows rows={[toDisplayRow("company-total", "Company (all locations)", false, companyTotal)]} />
            </tbody>
          </table>
        )}
      </Card>

      <Card className="p-4" data-testid="locations-table">
        <p className="eyebrow mb-2">Per-location breakdown</p>
        {displayRows.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-faint)" }}>No location activity yet this week.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="eyebrow text-left">
                <th className="py-1">Location</th>
                <th>Leads</th>
                <th>Appts set</th>
                <th>No-show rate</th>
                <th>Contracts</th>
                <th>Contract value</th>
                <th>Invoiced</th>
                <th>Cash collected</th>
                <th>Reviews</th>
              </tr>
            </thead>
            <tbody style={{ color: "var(--text-body)" }}>
              <TableRows rows={displayRows} />
            </tbody>
          </table>
        )}
      </Card>

      <p className="text-xs" style={{ color: "var(--text-faint)" }}>
        Avg star rating and avg margin aren&rsquo;t shown here: folding a per-day, per-location average into one weekly
        number would fabricate a number no single event actually produced (same &ldquo;medians don&rsquo;t fold&rdquo;
        rule the company-wide scorecard follows) — see the scorecard page for the company-wide, event-derived versions of those
        two measurables.
      </p>
    </div>
  );
}
