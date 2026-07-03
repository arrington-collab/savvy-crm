import Link from "next/link";
import { Card } from "@/components/ui/card";
import type { RoadmapTask } from "@savvy/db";

function healthColor(status: string): string {
  if (status === "green") return "var(--status-ok)";
  if (status === "amber") return "var(--status-skip)";
  if (status === "red") return "var(--status-error)";
  return "var(--text-faint)";
}

/**
 * The Automation Roadmap (read-only): manual/assisted tasks ranked by the human
 * time they cost over the last 30 days — automate the top of this list next.
 * The empire roadmap, made visible; founder-minutes come from the nightly sweep.
 */
export function AutomationRoadmap({ tasks }: { tasks: RoadmapTask[] }) {
  return (
    <Card className="p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="font-semibold">Automation Roadmap</h2>
        <span className="eyebrow" style={{ color: "var(--text-faint)" }}>by founder-minutes · 30d</span>
      </div>

      {tasks.length === 0 ? (
        <p className="mt-3 text-sm" style={{ color: "var(--text-faint)" }}>
          No manual attention logged in the last 30 days — nothing to prioritize yet.
        </p>
      ) : (
        <ol className="mt-3 space-y-1">
          {tasks.map((t, i) => (
            <li key={t.taskId}>
              <Link
                href={`/tasks/${t.taskId}`}
                className="flex items-center gap-3 rounded-lg px-2 py-2 text-sm hover:bg-[var(--accent-006)]"
                style={{ borderBottom: "1px solid var(--border-panel)" }}
              >
                <span className="mono w-5 shrink-0 text-[12px]" style={{ color: "var(--text-faint)" }}>{i + 1}</span>
                <span className="h-2 w-2 shrink-0 rounded-full" title={`health: ${t.healthStatus}`} style={{ background: healthColor(t.healthStatus) }} />
                <span className="mono w-8 shrink-0 text-[11px]" style={{ color: "var(--text-faint)" }}>P{t.phase}</span>
                <span className="min-w-0 flex-1 truncate" style={{ color: "var(--text-body)" }}>{t.name}</span>
                <span className="eyebrow shrink-0" style={{ fontSize: "0.55rem", color: "var(--text-faint)" }}>{t.effectiveMode}</span>
                <span className="mono shrink-0 text-[13px] text-accent-gold">{Math.round(t.founderMinutes30d)}m</span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
