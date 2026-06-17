import Link from "next/link";
import { getBoard, getStageVelocity, getDraftInvoicesByJob } from "@/lib/pipeline-queries";
import { Board } from "./board";
import { Card } from "@/components/ui/card";
import { MetricCard } from "@/components/cockpit/MetricCard";
import { AgentAvatar } from "@/components/cockpit/AgentAvatar";
import { PERSONAS, type Persona } from "@/lib/agents";

export const dynamic = "force-dynamic";

function daysInStage(stageEnteredAt: string): number {
  return Math.floor((Date.now() - Date.parse(stageEnteredAt)) / 86_400_000);
}

type Suggestion = { jobId: string; persona: Persona; text: string };

export default async function JobsPage() {
  const [board, velocity, draftInvoices] = await Promise.all([getBoard(), getStageVelocity(), getDraftInvoicesByJob()]);
  const activeStages = ["lead", "inspected", "estimate", "approved", "production", "closeout", "billing", "complete"] as const;
  const total = activeStages.reduce((n, s) => n + (board[s]?.length ?? 0), 0);

  // Sage suggestions — derived ONLY from real board signals (omit rail if none).
  // TODO: an "unsent invoice" signal needs invoice data not present on the board.
  const suggestions: Suggestion[] = [];
  for (const c of board.estimate ?? []) {
    const d = daysInStage(c.stageEnteredAt);
    if (d > 7) suggestions.push({ jobId: c.id, persona: PERSONAS.VERA, text: `${c.customerName}'s estimate has sat ${d}d — I can refresh the numbers.` });
  }
  for (const c of board.approved ?? []) {
    const d = daysInStage(c.stageEnteredAt);
    if (d > 7) suggestions.push({ jobId: c.id, persona: PERSONAS.MILO, text: `${c.customerName} is approved but unscheduled ${d}d — want me to find a slot?` });
  }
  // Real signal: jobs with a drafted (unsent) invoice — RAINE can send it.
  for (const di of draftInvoices) {
    suggestions.push({ jobId: di.jobId, persona: PERSONAS.RAINE, text: `${di.customerName} has a drafted invoice waiting — I can send it for the sign-off.` });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="eyebrow">Pipeline</div>
          <h1 className="text-2xl font-semibold tracking-tight">Jobs</h1>
        </div>
        <div className="mono text-sm" style={{ color: "var(--text-muted)" }}>{total} active jobs</div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="velocity">
        {activeStages.slice(0, 4).map((s) => (
          <MetricCard key={s} label={`${s} · avg days`} value={velocity[s] ?? "—"} />
        ))}
      </div>

      <div className="flex gap-4">
        <div className="min-w-0 flex-1">
          <Board initialBoard={board} />
        </div>

        {suggestions.length > 0 ? (
          <aside className="hidden w-72 shrink-0 xl:block">
            <Card className="p-4">
              <div className="mb-3 flex items-center gap-2">
                <AgentAvatar persona={PERSONAS.SAGE} size="sm" />
                <h2 className="eyebrow">Sage · suggestions</h2>
              </div>
              <ul className="space-y-3">
                {suggestions.slice(0, 6).map((s) => (
                  <li key={`${s.persona.key}-${s.jobId}`} className="text-sm">
                    <div className="flex items-start gap-2">
                      <AgentAvatar persona={s.persona} size="sm" />
                      <p style={{ color: "var(--text-body)" }}>{s.text}</p>
                    </div>
                    <Link
                      href={`/jobs/${s.jobId}`}
                      className="mono mt-1.5 ml-8 inline-block rounded-md px-2.5 py-1 text-[11px]"
                      style={{ background: "var(--accent-010)", border: "1px solid var(--accent-040)", color: "var(--text-primary)" }}
                    >
                      Open job →
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          </aside>
        ) : null}
      </div>
    </div>
  );
}
