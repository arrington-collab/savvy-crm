import Link from "next/link";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/cockpit/PageHeader";
import { partnerValueRows } from "@savvy/db";
import { rollupByClass } from "@savvy/core";
import { getTenantId } from "@/lib/tenant";

export const dynamic = "force-dynamic"; // always read live, tenant-scoped data

const CLASS_LABEL: Record<string, string> = {
  realtor: "Realtor", insurance_agent: "Insurance agent", property_manager: "Property manager", other: "Other",
};

function usd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function GradeChip({ grade }: { grade: string | null }) {
  const color = grade === "A" ? "var(--accent-gold)" : grade === "C" ? "var(--status-error)" : "var(--text-muted)";
  return (
    <span className="mono rounded px-1.5 py-0.5 text-[11px] font-semibold" style={{ border: `1px solid ${color}`, color }}>
      {grade ?? "—"}
    </span>
  );
}

// Partner Ledger slice 3: the ranked table. Read-mostly; actions arrive via
// cards (/today). Value = collected GM; open pipeline shown separately so new
// partners aren't judged prematurely; grades rank — humans end relationships.
export default async function PartnersPage() {
  const tenantId = await getTenantId();
  const rows = await partnerValueRows(tenantId, new Date());
  const rollups = rollupByClass(rows);

  return (
    <div className="space-y-5" data-testid="partners-page">
      <PageHeader eyebrow="Library · Partner Ledger" title="Partners" />
      <div className="flex items-center justify-between">
        <p className="max-w-2xl text-sm" style={{ color: "var(--text-muted)" }}>
          What each partner <b>produces</b> (collected gross margin) vs. what they <b>cost</b> (standard inspection
          cost, fees, free repairs, expenses) — trailing 12 months. Grades rank; you decide.
        </p>
        <span className="flex shrink-0 gap-2">
          <Link href="/partners/quarterly" className="mono rounded-md border px-3 py-1.5 text-[12px] font-semibold"
                style={{ borderColor: "var(--accent-040)", color: "var(--accent-gold)" }} data-testid="partners-quarterly">
            Quarterly
          </Link>
          <Link href="/partners/certs" className="mono rounded-md border px-3 py-1.5 text-[12px] font-semibold"
                style={{ borderColor: "var(--accent-040)", color: "var(--accent-gold)" }} data-testid="partners-certs">
            Roof certs
          </Link>
          <Link href="/partners/expense" className="mono rounded-md px-3 py-1.5 text-[12px] font-semibold"
                style={{ background: "var(--accent-gold)", color: "#1b1408" }} data-testid="partners-log-expense">
            Log expense
          </Link>
        </span>
      </div>

      {rollups.length > 1 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="partner-class-rollups">
          {rollups.map((r) => (
            <Card key={r.class} className="p-3.5">
              <div className="flex items-baseline justify-between">
                <span className="font-semibold">{CLASS_LABEL[r.class] ?? r.class}</span>
                <span className="mono text-[10px]" style={{ color: "var(--text-faint)" }}>{r.partners} partner{r.partners === 1 ? "" : "s"}</span>
              </div>
              <div className="mono mt-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
                {r.sent} sent · {r.won} won · net{" "}
                <b style={{ color: r.netCents >= 0 ? "var(--accent-gold)" : "var(--status-error)" }}>{usd(r.netCents)}</b>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Card className="overflow-x-auto p-0" data-testid="partner-table">
        <table className="w-full text-sm">
          <thead>
            <tr className="mono text-[10px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
              <th className="px-4 py-2.5 text-left">Grade</th>
              <th className="px-4 py-2.5 text-left">Partner</th>
              <th className="px-4 py-2.5 text-left">Class</th>
              <th className="px-4 py-2.5 text-right">Sent</th>
              <th className="px-4 py-2.5 text-right">Won</th>
              <th className="px-4 py-2.5 text-right">Collected GM</th>
              <th className="px-4 py-2.5 text-right">Cost 12mo</th>
              <th className="px-4 py-2.5 text-right">Net</th>
              <th className="px-4 py-2.5 text-right">Pipeline</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center" style={{ color: "var(--text-faint)" }}>
                  No partners yet — they appear when a lead arrives from a realtor, insurance agent or partner.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.partnerId} className="border-t" style={{ borderColor: "var(--border-panel)" }} data-testid="partner-row">
                  <td className="px-4 py-2.5"><GradeChip grade={r.grade} /></td>
                  <td className="px-4 py-2.5">
                    <Link href={`/partners/${r.partnerId}`} className="font-medium hover:underline">
                      {r.name}
                    </Link>
                    {r.org ? <span style={{ color: "var(--text-faint)" }}> · {r.org}</span> : null}
                  </td>
                  <td className="px-4 py-2.5" style={{ color: "var(--text-muted)" }}>{CLASS_LABEL[r.class] ?? r.class}</td>
                  <td className="mono px-4 py-2.5 text-right">{r.sent}</td>
                  <td className="mono px-4 py-2.5 text-right">{r.won}</td>
                  <td className="mono px-4 py-2.5 text-right">{usd(r.collectedGmCents)}</td>
                  <td className="mono px-4 py-2.5 text-right">{usd(r.cost12moCents)}</td>
                  <td className="mono px-4 py-2.5 text-right font-semibold"
                      style={{ color: r.netCents >= 0 ? "var(--accent-gold)" : "var(--status-error)" }}>
                    {usd(r.netCents)}
                  </td>
                  <td className="mono px-4 py-2.5 text-right" style={{ color: "var(--text-muted)" }}>{usd(r.openPipelineCents)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
