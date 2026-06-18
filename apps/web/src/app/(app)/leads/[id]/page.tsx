import { notFound } from "next/navigation";
import { getLeadDetail } from "@/lib/leads-queries";
import { listUsers } from "@/lib/scheduling-queries";
import { PageHeader } from "@/components/cockpit/PageHeader";
import { StatusBadge } from "@/components/cockpit/StatusBadge";
import { AgentAvatar } from "@/components/cockpit/AgentAvatar";
import { Card } from "@/components/ui/card";
import { ago } from "@/lib/format";
import { resolveAgent } from "@/lib/agents";
import { LeadActions } from "@/components/leads/LeadActions";

export const dynamic = "force-dynamic";

export default async function LeadDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [detail, users] = await Promise.all([getLeadDetail(id), listUsers()]);
  if (!detail) notFound();

  const qualifier = resolveAgent({ agent: "comms", taskKey: "lead.qualify" });

  return (
    <div className="space-y-6" data-testid="lead-detail">
      <PageHeader
        eyebrow="Lead"
        title={detail.customerName ?? "Lead"}
        right={<StatusBadge status={detail.status} />}
      />

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="p-4">
          <div className="eyebrow mb-1">AI score · ATLAS</div>
          <div className="text-3xl font-semibold" style={{ color: "var(--text-primary)" }} data-testid="lead-score">
            {detail.score ?? "—"}
          </div>
          <p className="mt-2 text-sm" style={{ color: "var(--text-muted)" }}>
            {detail.scoreReason ?? "Not yet qualified."}
          </p>
        </Card>
        <Card className="p-4">
          <div className="eyebrow mb-1">Contact</div>
          <p className="text-sm" style={{ color: "var(--text-body)" }}>{detail.address ?? "—"}</p>
          <p className="mono mt-1 text-xs" style={{ color: "var(--text-muted)" }}>source: {detail.source ?? "—"}</p>
        </Card>
        <Card className="p-4">
          <div className="eyebrow mb-1">Owner</div>
          <p className="text-sm" style={{ color: "var(--text-body)" }} data-testid="lead-owner">
            {detail.ownerName ?? "Unassigned"}
          </p>
        </Card>
      </div>

      <LeadActions leadId={detail.id} status={detail.status} users={users} ownerId={detail.assignedUserId} />

      <Card className="p-4">
        <div className="eyebrow mb-3">Communications</div>
        {detail.communications.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-faint)" }}>No communications yet.</p>
        ) : (
          <ul className="space-y-3">
            {detail.communications.map((c) => (
              <li key={c.id} className="flex items-start gap-2 text-sm">
                <AgentAvatar persona={qualifier.persona} size="sm" />
                <div>
                  <div className="mono text-xs" style={{ color: "var(--text-faint)" }}>
                    {c.channel} · {c.direction} · {ago(c.createdAt)}
                  </div>
                  <p style={{ color: "var(--text-body)" }}>{c.body ?? "—"}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
