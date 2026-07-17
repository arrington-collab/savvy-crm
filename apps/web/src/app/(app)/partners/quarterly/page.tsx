import Link from "next/link";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/cockpit/PageHeader";
import { internalQuarterlyRanking, marketPricingSummary } from "@savvy/db";
import { getTenantId } from "@/lib/tenant";

export const dynamic = "force-dynamic"; // always read live, tenant-scoped data

const CLASS_LABEL: Record<string, string> = {
  realtor: "Realtor", insurance_agent: "Insurance agent", property_manager: "Property manager", other: "Other",
};

function usd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

// The INTERNAL quarterly artifact (spec slice 5): everyone ranked by net,
// class rollups, biggest movers vs last quarter's snapshot, and the C-partner
// decisions still waiting on a human. The partner-facing page shows none of this.
export default async function PartnersQuarterlyPage() {
  const tenantId = await getTenantId();
  const art = await internalQuarterlyRanking(tenantId, new Date());
  const market = await marketPricingSummary(tenantId, new Date()).catch(() => null);

  return (
    <div className="space-y-5" data-testid="partners-quarterly-page">
      <PageHeader eyebrow={`Partner Ledger · Quarterly · ${art.quarterKey}`} title="Quarterly partner ranking" />
      <div className="flex items-center justify-between">
        <p className="max-w-2xl text-sm" style={{ color: "var(--text-muted)" }}>
          Internal view — trailing-12-month economics ranked by net, with the {art.quarterKey} report cycle&apos;s
          movers. {art.cCardsPending > 0 ? (
            <b style={{ color: "var(--status-error)" }}>{art.cCardsPending} C-partner decision{art.cCardsPending === 1 ? "" : "s"} outstanding on /today.</b>
          ) : "No C-partner decisions outstanding."}
        </p>
        <Link href="/partners" className="mono shrink-0 text-[12px] underline" style={{ color: "var(--accent-deep)" }}>
          ← Partner Ledger
        </Link>
      </div>

      {art.movers.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-3" data-testid="quarterly-movers">
          {art.movers.map((m) => (
            <Card key={m.partnerId} className="p-3.5">
              <div className="eyebrow">Mover</div>
              <div className="mt-1 font-medium">
                <Link href={`/partners/${m.partnerId}`} className="hover:underline">{m.name}</Link>
              </div>
              <div className="mono text-sm font-semibold"
                   style={{ color: m.deltaCents >= 0 ? "var(--accent-gold)" : "var(--status-error)" }}>
                {m.deltaCents >= 0 ? "+" : ""}{usd(m.deltaCents)} vs last quarter
              </div>
            </Card>
          ))}
        </div>
      )}

      {art.rollups.length > 1 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="quarterly-rollups">
          {art.rollups.map((r) => (
            <Card key={r.class} className="p-3.5">
              <div className="flex items-baseline justify-between">
                <span className="font-semibold">{CLASS_LABEL[r.class] ?? r.class}</span>
                <span className="mono text-[10px]" style={{ color: "var(--text-faint)" }}>{r.partners}</span>
              </div>
              <div className="mono mt-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
                {r.sent} sent · {r.won} won · net{" "}
                <b style={{ color: r.netCents >= 0 ? "var(--accent-gold)" : "var(--status-error)" }}>{usd(r.netCents)}</b>
              </div>
            </Card>
          ))}
        </div>
      )}

      {market && (
        <Card className="p-4" data-testid="market-pricing">
          <div className="eyebrow mb-2">
            Market pricing · {market.captures} captured bids · capture rate {market.captureRatePct}% (target, not a gate)
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {market.byArea.map((a) => (
              <div key={a.area} className="rounded-md border p-3" style={{ borderColor: "var(--border-panel)" }}>
                <div className="font-medium">{a.area}</div>
                <div className="mono mt-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
                  us ${(a.avgOurBidCents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })} · them $
                  {(a.avgCompetitorBidCents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}
                  {a.avgDeltaPct != null ? ` · ${a.avgDeltaPct > 0 ? "+" : ""}${a.avgDeltaPct}%` : ""}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card className="overflow-x-auto p-0" data-testid="quarterly-table">
        <table className="w-full text-sm">
          <thead>
            <tr className="mono text-[10px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
              <th className="px-4 py-2.5 text-left">#</th>
              <th className="px-4 py-2.5 text-left">Partner</th>
              <th className="px-4 py-2.5 text-left">Grade</th>
              <th className="px-4 py-2.5 text-right">Sent</th>
              <th className="px-4 py-2.5 text-right">Won</th>
              <th className="px-4 py-2.5 text-right">Net · 12mo</th>
            </tr>
          </thead>
          <tbody>
            {art.rows.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center" style={{ color: "var(--text-faint)" }}>No partners yet.</td></tr>
            ) : art.rows.map((r, i) => (
              <tr key={r.partnerId} className="border-t" style={{ borderColor: "var(--border-panel)" }} data-testid="quarterly-row">
                <td className="mono px-4 py-2.5" style={{ color: "var(--text-faint)" }}>{i + 1}</td>
                <td className="px-4 py-2.5">
                  <Link href={`/partners/${r.partnerId}`} className="font-medium hover:underline">{r.name}</Link>
                  {r.org ? <span style={{ color: "var(--text-faint)" }}> · {r.org}</span> : null}
                </td>
                <td className="mono px-4 py-2.5">{r.grade ?? "—"}</td>
                <td className="mono px-4 py-2.5 text-right">{r.sent}</td>
                <td className="mono px-4 py-2.5 text-right">{r.won}</td>
                <td className="mono px-4 py-2.5 text-right font-semibold"
                    style={{ color: r.netCents >= 0 ? "var(--accent-gold)" : "var(--status-error)" }}>
                  {usd(r.netCents)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
