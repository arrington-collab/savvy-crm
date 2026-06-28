import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import Link from "next/link";
import { getExceptionQueue } from "@/lib/exception-queries";

const KIND_LABEL: Record<string, string> = {
  job_at_risk: "Job at risk",
  invoice_overdue: "Invoice overdue",
  appointment_missed: "Appointment",
  task_overdue: "Task overdue",
  material_delivery: "Materials",
  task_needs_approval: "Needs approval",
};

export default async function ExceptionsPage() {
  const queue = await getExceptionQueue();
  return (
    <div className="space-y-6" data-testid="exceptions-page">
      <div className="flex items-end justify-between">
        <h1 className="text-2xl font-semibold">Exceptions</h1>
        <div className="text-right">
          <div className="mono text-2xl font-semibold text-accent-gold" data-testid="exceptions-total">{queue.total}</div>
          <div className="text-xs" style={{ color: "var(--text-faint)" }}>
            {queue.highCount} high priority
          </div>
        </div>
      </div>

      <Card>
        <CardHeader><CardTitle>Needs you</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {queue.items.length === 0 && (
            <p className="text-sm" style={{ color: "var(--text-faint)" }} data-testid="exceptions-empty">
              Nothing needs you right now. The agents have it.
            </p>
          )}
          {queue.items.map((item, i) => (
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
