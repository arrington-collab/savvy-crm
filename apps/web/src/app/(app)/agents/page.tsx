import Link from "next/link";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/cockpit/PageHeader";
import { AgentAvatar } from "@/components/cockpit/AgentAvatar";
import { LockedTile } from "@/components/cockpit/LockedTile";
import { getAgentRoster } from "@/lib/agent-roster-queries";

export const dynamic = "force-dynamic"; // always read live, tenant-scoped data

function ago(d: Date | null): string {
  if (!d) return "idle";
  const mins = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export default async function AgentsPage() {
  const roster = await getAgentRoster();

  return (
    <div className="space-y-6" data-testid="agents-page">
      <PageHeader
        eyebrow="Agents · Roster & Audit"
        title="Agents"
        right={
          <Link href="/command-center" className="mono text-[11px] hover:text-accent-gold" style={{ color: "var(--text-muted)" }} data-testid="telemetry-link">
            Telemetry (Command Center) ↗
          </Link>
        }
      />
      <p className="max-w-2xl text-sm" style={{ color: "var(--text-muted)" }}>
        Who does what, and who checks them. Tasks owned, 24-hour activity and audit score per agent — raw run
        telemetry lives one click deeper. <b style={{ color: "var(--accent-gold)", fontWeight: 500 }}>{roster.totalActions24h} actions</b> in the last 24h.
      </p>

      {/* ROSTER */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="agent-roster">
        {roster.cards.map((c) => (
          <Card key={c.persona.key} className="p-4" data-testid="roster-card" data-persona={c.persona.key}>
            <div className="flex items-center gap-3">
              <AgentAvatar persona={c.persona} />
              <div>
                <div className="font-semibold">{c.persona.name}</div>
                <div className="text-[11px]" style={{ color: "var(--text-faint)" }}>{c.persona.role}</div>
              </div>
              <span className="mono ml-auto text-[10px]" style={{ color: "var(--text-faint)" }}>{ago(c.lastRunAt)}</span>
            </div>
            <dl className="mono mt-3 space-y-1.5 text-[11px]">
              <Stat label="tasks owned" value={c.tasksOwned > 0 ? String(c.tasksOwned) : "—"} />
              <Stat label="actions · 24h" value={String(c.actions24h)} testId={`actions-${c.persona.key}`} />
              <Stat label="errors / skips" value={`${c.errors} / ${c.skips}`} bad={c.errors > 0} />
              <Stat label="audit (sampled)" value={c.auditPct != null ? `${c.auditPct}%` : "—"} />
            </dl>
          </Card>
        ))}
      </div>

      {/* AUDIT PRINCIPLE + LOCKED TILE */}
      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Card className="p-4" data-testid="audit-principle">
          <div className="eyebrow mb-2">Audit principle</div>
          <p className="text-[13px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
            <b style={{ color: "var(--text-body)", fontWeight: 500 }}>The checker is never the doer.</b> Tier 1: deterministic
            invariants (SQL against prod state). Tier 2: a second model re-does a random sample of judgment work — re-prices
            estimates, scores call transcripts. Tier 3: external truth — QuickBooks, Stripe, carrier portals. Disagreement at
            any tier becomes an exception in Today. Raw run telemetry (the old Command Center) lives one click deeper, per agent.
          </p>
          {roster.humanTasks > 0 ? (
            <p className="mono mt-3 text-[11px]" style={{ color: "var(--text-faint)" }}>
              {roster.humanTasks} of the 212 master tasks are still owned by you (manual) — the coverage map is the scoreboard for backgrounding them.
            </p>
          ) : null}
        </Card>

        <LockedTile
          phase="Phase 25"
          title="Labor Supply"
          tease="A marketplace of vetted crews and subs that the Dispatcher can draw from on demand — capacity that scales with the pipeline instead of capping it."
          thesis="Phase 25 turns scheduling from a constraint into a supply market: when demand spikes, MILO sources vetted crews and subs on demand rather than rescheduling. The console already knows capacity and demand per day — Labor Supply closes the loop by making labor itself elastic."
        />
      </div>
    </div>
  );
}

function Stat({ label, value, bad, testId }: { label: string; value: string; bad?: boolean; testId?: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt style={{ color: "var(--text-muted)" }}>{label}</dt>
      <dd data-testid={testId} style={{ color: bad ? "var(--status-error)" : value === "—" ? "var(--text-faint)" : "var(--text-body)" }}>{value}</dd>
    </div>
  );
}
