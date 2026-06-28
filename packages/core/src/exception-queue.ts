export type ExceptionKind = "job_at_risk" | "invoice_overdue" | "appointment_missed" | "task_overdue";
export type ExceptionSeverity = "high" | "medium";

export type ExceptionItem = {
  kind: ExceptionKind;
  severity: ExceptionSeverity;
  title: string;
  detail: string;
  href: string;
  occurredAt: Date | null;
};

export type AtRiskJobInput = { jobId: string; customerName: string | null; stuck: boolean; late: boolean; reasons: string[]; stageEnteredAt: Date };
export type OverdueInvoiceInput = { invoiceId: string; jobId: string | null; customerName: string | null; amountDueCents: number | null; dueAt: Date | null };
export type MissedAppointmentInput = { appointmentId: string; jobId: string; apptType: string; status: string; startsAt: Date; customerName: string | null };
export type OverdueTaskInput = { taskId: string; jobId: string; title: string; customerName: string | null; dueAt: Date | null };

export type ExceptionQueueInput = {
  atRiskJobs: AtRiskJobInput[];
  overdueInvoices: OverdueInvoiceInput[];
  missedAppointments: MissedAppointmentInput[];
  overdueTasks: OverdueTaskInput[];
};

export type ExceptionQueue = {
  items: ExceptionItem[];
  counts: Record<ExceptionKind, number>;
  total: number;
  highCount: number;
};

const KINDS: ExceptionKind[] = ["job_at_risk", "invoice_overdue", "appointment_missed", "task_overdue"];

function dollars(cents: number | null): string {
  return cents == null ? "" : `$${Math.round(cents / 100).toLocaleString()}`;
}

/** Normalize the four exception vectors into one severity-sorted worklist. Pure. */
export function buildExceptionQueue(input: ExceptionQueueInput): ExceptionQueue {
  const items: ExceptionItem[] = [];

  for (const j of input.atRiskJobs) {
    items.push({
      kind: "job_at_risk",
      severity: j.late ? "high" : "medium",
      title: j.customerName ?? "—",
      detail: j.reasons.length ? j.reasons.join("; ") : j.late ? "Late" : "Stuck",
      href: `/jobs/${j.jobId}`,
      occurredAt: j.stageEnteredAt,
    });
  }
  for (const inv of input.overdueInvoices) {
    const amt = dollars(inv.amountDueCents);
    items.push({
      kind: "invoice_overdue",
      severity: "high",
      title: inv.customerName ?? "—",
      detail: amt ? `Invoice overdue · ${amt}` : "Invoice overdue",
      href: "/invoices",
      occurredAt: inv.dueAt,
    });
  }
  for (const a of input.missedAppointments) {
    const missed = a.status === "no_show";
    items.push({
      kind: "appointment_missed",
      severity: missed ? "high" : "medium",
      title: a.customerName ?? "—",
      detail: `${a.apptType} ${missed ? "no-show" : "overdue"}`,
      href: "/schedule",
      occurredAt: a.startsAt,
    });
  }
  for (const t of input.overdueTasks) {
    items.push({
      kind: "task_overdue",
      severity: "medium",
      title: t.customerName ?? "—",
      detail: `Task overdue: ${t.title}`,
      href: `/jobs/${t.jobId}`,
      occurredAt: t.dueAt,
    });
  }

  const sevRank = (s: ExceptionSeverity) => (s === "high" ? 0 : 1);
  items.sort((a, b) => {
    const s = sevRank(a.severity) - sevRank(b.severity);
    if (s !== 0) return s;
    const at = a.occurredAt ? a.occurredAt.getTime() : Infinity;
    const bt = b.occurredAt ? b.occurredAt.getTime() : Infinity;
    return at - bt;
  });

  const counts = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<ExceptionKind, number>;
  for (const i of items) counts[i.kind] += 1;

  return { items, counts, total: items.length, highCount: items.filter((i) => i.severity === "high").length };
}
