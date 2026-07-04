import { materialDeliveryFlag } from "./material-order";

export type ExceptionKind = "job_at_risk" | "invoice_overdue" | "appointment_missed" | "task_overdue" | "material_delivery" | "task_needs_approval" | "weather_at_risk" | "roof_type_needed" | "margin_outlier" | "photo_incomplete" | "photo_unmatched" | "photo_quality" | "supplier_invoice_unmatched" | "supplier_credit_review" | "supplier_credit_reconcile";
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
export type MaterialDeliveryInput = { materialOrderId: string; jobId: string; customerName: string | null; neededByAt: Date | null; installAt: Date | null; createdAt: Date };
export type TaskNeedsApprovalInput = { taskId: string; jobId: string; title: string; customerName: string | null; deferredAt: Date };
export type WeatherAtRiskInput = { appointmentId: string; jobId: string; apptType: string; startsAt: Date; customerName: string | null; note: string };
export type RoofTypeNeededInput = { jobId: string; leadId: string | null; propertyId: string; customerName: string | null; occurredAt: Date };
export type MarginOutlierInput = { jobId: string; customerName: string | null; marginPct: number; occurredAt: Date | null };
export type PhotoIncompleteInput = { jobId: string; customerName: string | null; missing: string[]; occurredAt: Date | null };
export type PhotoUnmatchedInput = { documentId: string; captureAddress: string | null; occurredAt: Date | null };
export type PhotoQualityInput = { documentId: string; jobId: string; label: string | null; reason: string; occurredAt: Date | null };
export type SupplierInvoiceUnmatchedInput = { id: string; supplierName: string | null; createdAt: Date };
export type CreditToReviewInput = { id: string; jobId: string | null; supplierName: string | null; claimedCents: number; createdAt: Date };
export type CreditToReconcileInput = { id: string; supplierName: string | null; amountCents: number; createdAt: Date };

export type ExceptionQueueInput = {
  atRiskJobs: AtRiskJobInput[];
  overdueInvoices: OverdueInvoiceInput[];
  missedAppointments: MissedAppointmentInput[];
  overdueTasks: OverdueTaskInput[];
  materialDeliveries: MaterialDeliveryInput[];
  taskNeedsApprovals: TaskNeedsApprovalInput[];
  weatherAtRisks: WeatherAtRiskInput[];
  roofTypeNeeded?: RoofTypeNeededInput[];
  marginOutliers?: MarginOutlierInput[];
  photoIncomplete?: PhotoIncompleteInput[];
  photoUnmatched?: PhotoUnmatchedInput[];
  photoQuality?: PhotoQualityInput[];
  supplierInvoicesUnmatched?: SupplierInvoiceUnmatchedInput[];
  creditsToReview?: CreditToReviewInput[];
  creditsToReconcile?: CreditToReconcileInput[];
};

export type ExceptionQueue = {
  items: ExceptionItem[];
  counts: Record<ExceptionKind, number>;
  total: number;
  highCount: number;
};

const KINDS: ExceptionKind[] = ["job_at_risk", "invoice_overdue", "appointment_missed", "task_overdue", "material_delivery", "task_needs_approval", "weather_at_risk", "roof_type_needed", "margin_outlier", "photo_incomplete", "photo_unmatched", "photo_quality", "supplier_invoice_unmatched", "supplier_credit_review", "supplier_credit_reconcile"];

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
  for (const m of input.materialDeliveries) {
    const flag = materialDeliveryFlag({ neededByAt: m.neededByAt, installAt: m.installAt });
    if (flag === "none") continue;
    const misaligned = flag === "misaligned";
    items.push({
      kind: "material_delivery",
      severity: misaligned ? "high" : "medium",
      title: m.customerName ?? "—",
      detail: misaligned ? "Materials arrive after install" : "No install scheduled for materials",
      href: `/jobs/${m.jobId}`,
      occurredAt: misaligned ? m.installAt : m.createdAt,
    });
  }
  for (const t of input.taskNeedsApprovals) {
    items.push({
      kind: "task_needs_approval",
      severity: "medium",
      title: t.customerName ?? "—",
      detail: `Needs approval: ${t.title}`,
      href: `/jobs/${t.jobId}`,
      occurredAt: t.deferredAt,
    });
  }
  for (const w of input.weatherAtRisks) {
    items.push({
      kind: "weather_at_risk",
      severity: "medium",
      title: w.customerName ?? "—",
      detail: `${w.note} — reschedule`,
      href: "/schedule",
      occurredAt: w.startsAt,
    });
  }

  for (const r of input.roofTypeNeeded ?? []) {
    items.push({
      kind: "roof_type_needed",
      severity: "medium",
      title: r.customerName ?? "—",
      detail: "Roof type unknown — capture it",
      href: r.leadId ? `/leads/${r.leadId}` : `/jobs/${r.jobId}`,
      occurredAt: r.occurredAt,
    });
  }

  for (const m of input.marginOutliers ?? []) {
    items.push({
      kind: "margin_outlier",
      // A losing job (negative margin) is urgent; a merely thin one is a heads-up.
      severity: m.marginPct < 0 ? "high" : "medium",
      title: m.customerName ?? "—",
      detail: `Margin ${m.marginPct}%${m.marginPct < 0 ? " — losing money" : " — below target"}`,
      href: `/jobs/${m.jobId}`,
      occurredAt: m.occurredAt,
    });
  }

  for (const p of input.photoIncomplete ?? []) {
    items.push({
      kind: "photo_incomplete",
      severity: "medium",
      title: p.customerName ?? "—",
      detail: `Photos incomplete: ${p.missing.join(", ")}`,
      href: `/jobs/${p.jobId}`,
      occurredAt: p.occurredAt,
    });
  }

  for (const p of input.photoUnmatched ?? []) {
    items.push({
      kind: "photo_unmatched",
      severity: "medium",
      title: "Unmatched photo",
      detail: `SiteSnap photo needs a job${p.captureAddress ? ` — ${p.captureAddress}` : ""}`,
      href: `/photos/unmatched`,
      occurredAt: p.occurredAt,
    });
  }

  for (const p of input.photoQuality ?? []) {
    items.push({
      kind: "photo_quality",
      severity: "medium",
      title: "Photo needs attention",
      detail: `${p.label ? `${p.label}: ` : ""}${p.reason}`,
      href: `/jobs/${p.jobId}`,
      occurredAt: p.occurredAt,
    });
  }

  for (const s of input.supplierInvoicesUnmatched ?? []) {
    items.push({
      kind: "supplier_invoice_unmatched",
      severity: "medium",
      title: "Unmatched supplier invoice",
      detail: `${s.supplierName ?? "Unknown supplier"} — no job matched`,
      href: "/library",
      occurredAt: s.createdAt,
    });
  }

  for (const c of input.creditsToReview ?? []) {
    items.push({
      kind: "supplier_credit_review",
      severity: "high",
      title: "Review & send credit request",
      detail: `${dollars(c.claimedCents)} — ${c.supplierName ?? "supplier"}`,
      href: c.jobId ? `/jobs/${c.jobId}` : "/money",
      occurredAt: c.createdAt,
    });
  }

  for (const c of input.creditsToReconcile ?? []) {
    items.push({
      kind: "supplier_credit_reconcile",
      severity: "medium",
      title: "Reconcile credit memo",
      detail: `${dollars(c.amountCents)} — ${c.supplierName ?? "supplier"}`,
      href: "/money",
      occurredAt: c.createdAt,
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
