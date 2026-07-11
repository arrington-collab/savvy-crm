import Link from "next/link";
import { getLeads, getLeadFunnelCounts } from "@/lib/leads-queries";
import { PageHeader } from "@/components/cockpit/PageHeader";
import { MetricCard } from "@/components/cockpit/MetricCard";
import { StatusBadge } from "@/components/cockpit/StatusBadge";
import { AgentAvatar } from "@/components/cockpit/AgentAvatar";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { NewCallButton } from "./NewCallButton";
import { LeadsScrollRestore } from "./LeadsScrollRestore";
import { ago } from "@/lib/format";
import { leadStatusPersona } from "@/lib/agents";
import { LEAD_STATUS, type LeadStatus, buildLeadRowHref } from "@savvy/core";
import { CardInflight } from "@/components/inflight/CardInflight";

export const dynamic = "force-dynamic";

const COLS = "grid grid-cols-[56px_1fr_1fr_84px_104px_64px_40px] items-center gap-2";

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; sort?: string }>;
}) {
  const sp = await searchParams;
  const status = LEAD_STATUS.includes(sp.status as LeadStatus) ? (sp.status as LeadStatus) : undefined;
  const sort: "score" | "age" = sp.sort === "age" ? "age" : "score";
  const [counts, leads] = await Promise.all([getLeadFunnelCounts(), getLeads({ status, sort })]);
  const total = LEAD_STATUS.reduce((n, s) => n + (counts[s] ?? 0), 0);
  const statusQs = status ? `&status=${status}` : "";

  return (
    <div className="space-y-6">
      <LeadsScrollRestore />
      <PageHeader
        eyebrow="Funnel"
        title="Leads"
        right={
          <div className="flex gap-2">
            <NewCallButton />
            <Link href="/leads/new">
              <Button data-testid="new-lead">+ New Lead</Button>
            </Link>
          </div>
        }
      />

      <div className="grid grid-cols-3 gap-3 sm:grid-cols-7" data-testid="funnel">
        <Link href="/leads">
          <MetricCard label="all" value={total} testId="funnel-all" />
        </Link>
        {LEAD_STATUS.map((s) => (
          <Link key={s} href={`/leads?status=${s}`}>
            <MetricCard label={s} value={counts[s] ?? 0} testId={`funnel-${s}`} />
          </Link>
        ))}
      </div>

      <Card className="overflow-hidden p-0">
        <div className={`${COLS} border-b border-white/10 px-4 py-2`}>
          <Link href={`/leads?sort=score${statusQs}`} className="eyebrow">score</Link>
          <span className="eyebrow">customer</span>
          <span className="eyebrow">address</span>
          <span className="eyebrow">source</span>
          <span className="eyebrow">status</span>
          <Link href={`/leads?sort=age${statusQs}`} className="eyebrow">age</Link>
          <span className="eyebrow">agent</span>
        </div>

        {leads.length === 0 ? (
          <div
            className="px-4 py-12 text-center text-sm"
            style={{ color: "var(--text-faint)" }}
            data-testid="leads-empty"
          >
            No leads yet.{" "}
            <Link href="/leads/new" className="underline">
              Add your first lead.
            </Link>
          </div>
        ) : (
          leads.map((l) => {
            const { persona, dimmed } = leadStatusPersona(l.status);
            return (
              <Link
                key={l.id}
                href={buildLeadRowHref(l.id, { status, sort })}
                data-testid="lead-row"
                data-lead-id={l.id}
                className={`${COLS} border-b border-white/5 px-4 py-3 text-sm hover:bg-white/[0.03]`}
              >
                <span className="mono font-semibold" style={{ color: "var(--text-primary)" }}>
                  {l.score ?? "—"}
                </span>
                <span style={{ color: "var(--text-body)" }}>{l.customerName ?? "—"}</span>
                <span className="truncate" style={{ color: "var(--text-muted)" }}>{l.address ?? "—"}</span>
                <span className="mono text-xs" style={{ color: "var(--text-muted)" }}>{l.source ?? "—"}</span>
                <span><StatusBadge status={l.status} /></span>
                <span className="mono text-xs" style={{ color: "var(--text-muted)" }}>{ago(l.createdAt)}</span>
                <span className="flex items-center gap-1.5">
                  <AgentAvatar persona={persona} size="sm" dimmed={dimmed} />
                  <CardInflight kind="lead" id={l.id} />
                </span>
              </Link>
            );
          })
        )}
      </Card>
    </div>
  );
}
