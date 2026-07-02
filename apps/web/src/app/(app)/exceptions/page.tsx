import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import Link from "next/link";
import { getExceptionQueue } from "@/lib/exception-queries";
import { loadOpenTaskExceptions } from "@/lib/scoreboard-queries";

const KIND_LABEL: Record<string, string> = {
  job_at_risk: "Job at risk",
  invoice_overdue: "Invoice overdue",
  appointment_missed: "Appointment",
  task_overdue: "Task overdue",
  material_delivery: "Materials",
  task_needs_approval: "Needs approval",
  weather_at_risk: "Weather risk",
  roof_type_needed: "Roof type",
  // scoreboard task exceptions
  verification_mismatch: "Done-but-wrong",
  task_stale: "Stale check",
  task_regression: "Regressed",
};

type WorklistRow = { kind: string; severity: "high" | "medium"; title: string; detail: string; href: string };

function usd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

export default async function ExceptionsPage() {
  const [queue, taskExceptions] = await Promise.all([getExceptionQueue(), loadOpenTaskExceptions()]);

  // One unified worklist: operational vectors + scoreboard task exceptions
  // (which cite a task and link to its proof page). High-severity first.
  const rows: WorklistRow[] = [
    ...queue.items.map((i) => ({ kind: i.kind, severity: i.severity, title: i.title, detail: i.detail, href: i.href })),
    ...taskExceptions.map((e) => ({
      kind: e.kind,
      severity: e.severity === "high" ? ("high" as const) : ("medium" as const),
      title: e.name,
      detail: e.dollarImpactCents > 0 ? `${usd(e.dollarImpactCents)} at risk` : KIND_LABEL[e.kind] ?? e.kind,
      href: `/tasks/${e.taskId}`,
    })),
  ];
  rows.sort((a, b) => (a.severity === "high" ? 0 : 1) - (b.severity === "high" ? 0 : 1));
  const highCount = rows.filter((r) => r.severity === "high").length;

  return (
    <div className="space-y-6" data-testid="exceptions-page">
      <div className="flex items-end justify-between">
        <h1 className="text-2xl font-semibold">Exceptions</h1>
        <div className="text-right">
          <div className="mono text-2xl font-semibold text-accent-gold" data-testid="exceptions-total">{rows.length}</div>
          <div className="text-xs" style={{ color: "var(--text-faint)" }}>
            {highCount} high priority
          </div>
        </div>
      </div>

      <Card>
        <CardHeader><CardTitle>Needs you</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {rows.length === 0 && (
            <p className="text-sm" style={{ color: "var(--text-faint)" }} data-testid="exceptions-empty">
              Nothing needs you right now. The agents have it.
            </p>
          )}
          {rows.map((item, i) => (
            <Link
              key={`${item.kind}-${i}`}
              href={item.href}
              className="block rounded-md border border-border px-3 py-2 text-sm hover:bg-muted/50 transition-colors"
              data-testid="exception-row"
              data-severity={item.severity}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ background: item.severity === "high" ? "var(--color-destructive, #dc2626)" : "var(--accent-gold)" }}
                  />
                  <span style={{ color: "var(--text-muted)" }}>{KIND_LABEL[item.kind] ?? item.kind}</span>
                  <span className="font-medium">{item.title}</span>
                </span>
                <span className="mono text-xs" style={{ color: "var(--text-faint)" }}>{item.detail}</span>
              </div>
            </Link>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
