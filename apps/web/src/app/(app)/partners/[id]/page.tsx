import Link from "next/link";
import { notFound } from "next/navigation";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/cockpit/PageHeader";
import { partnerValueRows, withTenant, partner, partnerLedgerEntry, eq, and } from "@savvy/db";
import { funnelConversions } from "@savvy/core";
import { getTenantId } from "@/lib/tenant";

export const dynamic = "force-dynamic"; // always read live, tenant-scoped data

const KIND_LABEL: Record<string, string> = {
  inspection_standard: "Inspection (standard)", free_repair: "Free repair", referral_fee: "Referral fee",
  cert_cost: "Cert cost", expense: "Expense",
};

function usd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

// Partner detail: the funnel with conversion rates, then every ledger entry —
// the numbers behind the grade, inspectable line by line.
export default async function PartnerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenantId = await getTenantId();

  const [p, rows, entries] = await Promise.all([
    withTenant(tenantId, (tx) =>
      tx.select().from(partner).where(and(eq(partner.tenantId, tenantId), eq(partner.id, id))).then((r) => r[0]),
    ),
    partnerValueRows(tenantId, new Date()),
    withTenant(tenantId, (tx) =>
      tx.select().from(partnerLedgerEntry)
        .where(and(eq(partnerLedgerEntry.tenantId, tenantId), eq(partnerLedgerEntry.partnerId, id)))
        .orderBy(partnerLedgerEntry.occurredAt),
    ),
  ]);
  if (!p) notFound();
  const v = rows.find((r) => r.partnerId === id);
  const conv = v ? funnelConversions(v) : null;

  return (
    <div className="space-y-5" data-testid="partner-detail-page">
      <PageHeader
        eyebrow={`Partners · ${p.class.replace("_", " ")}${p.grade ? ` · grade ${p.grade}` : ""}`}
        title={p.org ? `${p.name} — ${p.org}` : p.name}
      />
      <div className="flex gap-2 text-sm" style={{ color: "var(--text-muted)" }}>
        <Link href="/partners" className="underline">← All partners</Link>
        {p.slackCapacityOnly ? <span className="mono text-[11px]" style={{ color: "var(--status-error)" }}>slack-capacity only</span> : null}
        {p.schedulingPriority ? <span className="mono text-[11px]" style={{ color: "var(--accent-gold)" }}>scheduling priority</span> : null}
      </div>

      {v && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="partner-funnel">
          <Card className="p-3.5">
            <div className="eyebrow">Funnel · 12mo</div>
            <div className="mono mt-1 text-sm">
              {v.sent} sent → {v.inspected} inspected → {v.estimated} estimated → <b>{v.won} won</b>
            </div>
            {conv && conv.wonPct != null && (
              <div className="mono mt-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
                {conv.inspectedPct}% · {conv.estimatedPct}% · {conv.wonPct}% of sent
                {v.medianDaysToConvert != null ? ` · median ${v.medianDaysToConvert}d to convert` : ""}
              </div>
            )}
          </Card>
          <Card className="p-3.5">
            <div className="eyebrow">Collected GM</div>
            <div className="mono mt-1 text-lg font-semibold">{usd(v.collectedGmCents)}</div>
          </Card>
          <Card className="p-3.5">
            <div className="eyebrow">Cost · 12mo</div>
            <div className="mono mt-1 text-lg font-semibold">{usd(v.cost12moCents)}</div>
          </Card>
          <Card className="p-3.5">
            <div className="eyebrow">Net {v.openPipelineCents > 0 ? `· pipeline ${usd(v.openPipelineCents)}` : ""}</div>
            <div className="mono mt-1 text-lg font-semibold"
                 style={{ color: v.netCents >= 0 ? "var(--accent-gold)" : "var(--status-error)" }}>
              {usd(v.netCents)}
            </div>
          </Card>
        </div>
      )}

      <Card className="p-4" data-testid="partner-ledger-entries">
        <div className="eyebrow mb-2">Ledger · {entries.length} entr{entries.length === 1 ? "y" : "ies"}</div>
        {entries.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-faint)" }}>Nothing accrued yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {entries.map((e) => (
              <li key={e.id} className="flex items-baseline gap-3 text-[13px]">
                <span className="mono w-24 shrink-0 text-[11px]" style={{ color: "var(--text-faint)" }}>
                  {new Date(e.occurredAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" })}
                </span>
                <span className="w-44 shrink-0" style={{ color: "var(--text-muted)" }}>{KIND_LABEL[e.kind] ?? e.kind}</span>
                <span className="mono font-medium" style={{ color: e.direction === "revenue" ? "var(--accent-gold)" : "var(--text-body)" }}>
                  {e.direction === "revenue" ? "+" : "−"}{usd(e.amountCents)}
                </span>
                {e.note ? <span className="truncate text-[12px]" style={{ color: "var(--text-faint)" }}>{e.note}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
