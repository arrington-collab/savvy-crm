import { notFound } from "next/navigation";
import Link from "next/link";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { loadTaskDetail } from "@/lib/scoreboard-queries";
import { TaskViewTracker } from "./TaskViewTracker";

export const dynamic = "force-dynamic"; // always read live, tenant-scoped data

function ago(d: Date | null): string {
  if (!d) return "—";
  const mins = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}
function usd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

// health status → token
function healthColor(status: string | null | undefined): string {
  if (status === "green") return "var(--status-ok)";
  if (status === "amber") return "var(--status-skip)";
  if (status === "red") return "var(--status-error)";
  return "var(--text-faint)";
}
// verification_run status → token
function vColor(status: string): string {
  if (status === "pass") return "var(--status-ok)";
  if (status === "fail") return "var(--status-error)";
  return "var(--status-skip)"; // stale / skip
}
// job/lead ledger status → token
function ledgerColor(status: string): string {
  if (status === "verified") return "var(--status-ok)";
  if (status === "exception") return "var(--status-error)";
  if (status === "done") return "var(--accent-gold)";
  if (status === "blocked") return "var(--status-skip)";
  return "var(--text-faint)";
}

function Pill({ label, color }: { label: string; color: string }) {
  return (
    <span
      className="mono rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider"
      style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)`, border: `1px solid color-mix(in srgb, ${color} 35%, transparent)` }}
    >
      {label}
    </span>
  );
}

export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const taskId = Number(id);
  if (!Number.isInteger(taskId)) notFound();

  const detail = await loadTaskDetail(taskId);
  if (!detail) notFound();

  return (
    <div className="space-y-6" data-testid="task-detail">
      {/* Stamp first_viewed_at once (founder-minutes clock starts on open). */}
      <TaskViewTracker taskId={taskId} />

      <div className="flex items-end justify-between">
        <div>
          <div className="eyebrow">Task #{detail.taskId} · Phase {detail.phase}</div>
          <h1 className="text-2xl font-semibold tracking-tight">{detail.name}</h1>
        </div>
        {detail.health ? <Pill label={detail.health.status} color={healthColor(detail.health.status)} /> : <Pill label="unscored" color="var(--text-faint)" />}
      </div>

      {detail.exception ? (
        <Card style={{ borderColor: "color-mix(in srgb, var(--status-error) 35%, transparent)" }}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Open exception
              <Pill label={detail.exception.severity} color={detail.exception.severity === "high" ? "var(--status-error)" : "var(--accent-gold)"} />
              {detail.exception.breakGlass ? <Pill label="break-glass" color="var(--status-error)" /> : null}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mono text-sm" style={{ color: "var(--text-muted)" }}>
              {detail.exception.kind}
              {detail.exception.dollarImpactCents > 0 ? ` · ${usd(detail.exception.dollarImpactCents)} at risk` : ""}
              {" · opened "}{ago(detail.exception.openedAt)}
              {detail.exception.firstViewedAt ? ` · first viewed ${ago(detail.exception.firstViewedAt)}` : ""}
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader><CardTitle>Health</CardTitle></CardHeader>
        <CardContent>
          {detail.health ? (
            <div className="mono grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4" style={{ color: "var(--text-muted)" }}>
              <div>mode<br /><span style={{ color: "var(--text-body)" }}>{detail.health.effectiveMode}</span></div>
              <div>clean streak<br /><span style={{ color: "var(--text-body)" }}>{detail.health.cleanStreakDays}d</span></div>
              <div>fails · 7d<br /><span style={{ color: "var(--text-body)" }}>{detail.health.failCount7d}</span></div>
              <div>last verified<br /><span style={{ color: "var(--text-body)" }}>{ago(detail.health.lastVerifiedAt)}</span></div>
            </div>
          ) : (
            <p className="text-sm" style={{ color: "var(--text-faint)" }}>Not scored yet — the nightly sweep hasn&apos;t evaluated this task.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Recent checks</CardTitle></CardHeader>
        <CardContent>
          {detail.verifications.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--text-faint)" }}>No verification runs yet.</p>
          ) : (
            <ul className="space-y-1">
              {detail.verifications.map((v, i) => (
                <li key={i} className="flex items-center gap-3 text-sm" style={{ borderBottom: "1px solid var(--border-panel)" }}>
                  <Pill label={v.status} color={vColor(v.status)} />
                  <span className="mono truncate text-[12px]" style={{ color: "var(--accent-deep)" }}>{v.checkKey}</span>
                  <span className="mono ml-auto text-[11px]" style={{ color: "var(--text-faint)" }}>{ago(v.ranAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Ledger instances</CardTitle></CardHeader>
        <CardContent>
          {detail.instances.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--text-faint)" }}>No instances yet — this task hasn&apos;t run on any job or lead.</p>
          ) : (
            <ul className="space-y-1">
              {detail.instances.map((inst, i) => (
                <li key={i} className="flex items-center gap-3 text-sm" style={{ borderBottom: "1px solid var(--border-panel)" }}>
                  <Link href={inst.entity === "job" ? `/jobs/${inst.entityId}` : `/leads/${inst.entityId}`} className="hover:underline" style={{ color: "var(--text-body)" }}>
                    {inst.entity} · {inst.entityId.slice(0, 8)}
                  </Link>
                  {inst.evidence ? (
                    <span className="mono truncate text-[11px]" style={{ color: "var(--accent-deep)" }}>{inst.evidence.type}:{inst.evidence.ref}</span>
                  ) : null}
                  {inst.owner ? <span className="mono text-[11px]" style={{ color: "var(--text-faint)" }}>{inst.owner}</span> : null}
                  <span className="ml-auto"><Pill label={inst.status} color={ledgerColor(inst.status)} /></span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
