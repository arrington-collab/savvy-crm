import "server-only";
import { withTenant, invoice, payment, job, commission, inArray, gte, and, eq, sql } from "@savvy/db";
import { bucketArAging, computeMtdGrossMargin, type ArAging } from "@savvy/core";
import { getTenantId } from "./tenant";
import { maintenanceMrrCents, membershipProgramUsed } from "@savvy/db";

const WEEK_MS = 7 * 86_400_000;
// WIP = value committed but not yet closed/paid (approved through billing).
const WIP_STAGES = ["approved", "production", "closeout", "billing"] as const;

export type MoneyKpis = {
  cashWkCents: number;
  wipCents: number;
  wipJobs: number;
  gmMtdPct: number | null; // real MTD gross margin from job cost actuals; null → "—" when no costed job invoiced this month
  aging: ArAging;
  commissions: { pendingCents: number; approvedCents: number; paidCents: number };
  /** Phase 20: monthly-equivalent recurring revenue from active memberships; null = program unused. */
  mrrCents: number | null;
};

export async function getMoneyKpis(now: Date = new Date()): Promise<MoneyKpis> {
  const tenantId = await getTenantId();
  const weekAgo = new Date(now.getTime() - WEEK_MS);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [invoices, cashRows, wipRows, commRows, gmRows] = await Promise.all([
    withTenant(tenantId, (tx) =>
      tx
        .select({ amountDue: invoice.amountDue, amountPaid: invoice.amountPaid, dueAt: invoice.dueAt })
        .from(invoice)
        .where(and(eq(invoice.tenantId, tenantId), inArray(invoice.status, ["sent", "overdue"]))),
    ),
    withTenant(tenantId, (tx) =>
      tx
        .select({ total: sql<string>`coalesce(sum(${payment.amount}), 0)` })
        .from(payment)
        .where(and(eq(payment.tenantId, tenantId), gte(payment.receivedAt, weekAgo))),
    ),
    withTenant(tenantId, (tx) =>
      tx
        .select({ total: sql<string>`coalesce(sum(${job.valueEstimate}), 0)`, n: sql<string>`count(*)` })
        .from(job)
        .where(and(eq(job.tenantId, tenantId), inArray(job.stage, [...WIP_STAGES]))),
    ),
    withTenant(tenantId, (tx) =>
      tx
        .select({ status: commission.status, total: sql<string>`coalesce(sum(${commission.amountCents}), 0)` })
        .from(commission)
        .where(eq(commission.tenantId, tenantId))
        .groupBy(commission.status),
    ),
    // Jobs invoiced (non-draft invoice) this month → real MTD gross margin from
    // job.costCents actuals. selectDistinct dedupes jobs with multiple invoices
    // (the value/cost columns are per-job, so distinct yields one row per job).
    withTenant(tenantId, (tx) =>
      tx
        .selectDistinct({ jobId: job.id, valueFinal: job.valueFinal, valueEstimate: job.valueEstimate, costCents: job.costCents })
        .from(job)
        .innerJoin(invoice, eq(invoice.jobId, job.id))
        .where(and(
          eq(job.tenantId, tenantId),
          inArray(invoice.status, ["sent", "paid", "overdue"]),
          gte(invoice.createdAt, monthStart),
        )),
    ),
  ]);

  const byStatus = new Map<string, number>(commRows.map((r) => [r.status, Number(r.total)]));
  const commissions = {
    pendingCents: byStatus.get("pending") ?? 0,
    approvedCents: byStatus.get("approved") ?? 0,
    paidCents: byStatus.get("paid") ?? 0,
  };

  const gmMtdPct = computeMtdGrossMargin(
    gmRows.map((r) => ({ revenueCents: r.valueFinal ?? r.valueEstimate ?? 0, costCents: r.costCents ?? null })),
  );

  return {
    cashWkCents: Number(cashRows[0]?.total ?? 0),
    mrrCents: (await membershipProgramUsed(tenantId)) ? await maintenanceMrrCents(tenantId) : null,
    wipCents: Number(wipRows[0]?.total ?? 0),
    wipJobs: Number(wipRows[0]?.n ?? 0),
    gmMtdPct,
    aging: bucketArAging({
      openInvoices: invoices.map((i) => ({
        amountDueCents: i.amountDue ?? 0,
        amountPaidCents: i.amountPaid ?? 0,
        dueAt: i.dueAt ? new Date(i.dueAt as unknown as string) : null,
      })),
      now,
    }),
    commissions,
  };
}

// Friendly labels for the nightly proof-of-correctness checks (mockup style).
const CHECK_LABEL: Record<string, string> = {
  "finance.invoice_math": "Invoice totals = line items",
  "finance.commissions": "Commission = plan % × basis",
  "finance.price_guard": "Supplier invoices 100% price-checked",
  "finance.qb_reconcile": "Savvy AR ↔ QuickBooks",
  "finance.stripe_match": "Stripe payouts ↔ payments",
  "comms.no_double_send": "No duplicate outbound messages",
  "comms.body_quality": "Outbound bodies are clean",
  "lead.dedupe": "No duplicate active leads",
  "lead.score": "Every lead scored",
  "lead.speed_to_contact": "Speed-to-lead within SLA",
  "lead.enrich.geocode": "Leads geocoded",
  "lead.enrich.stormproof": "Leads storm-enriched",
  "drip.appended_guard": "No appended-email in drips",
  "exceptions.roof_type": "Roof type recorded post-inspection",
};

export type ProofRow = { checkKey: string; label: string; status: string; message: string | null; refCount: number; ranAt: string };

/** Latest verification_run per check for the nightly proof-of-correctness panel. */
export async function getVerificationProof(): Promise<ProofRow[]> {
  const tenantId = await getTenantId();
  const result = await withTenant(tenantId, (tx) =>
    tx.execute(sql`
      select distinct on (check_key)
        check_key, status, details, refs, ran_at
      from verification_run
      where tenant_id = ${tenantId}
      order by check_key, ran_at desc
    `),
  );
  const rows = (Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? []) as {
    check_key: string; status: string; details: { message?: string } | null; refs: unknown[] | null; ran_at: string;
  }[];
  return rows
    .map((r) => ({
      checkKey: r.check_key,
      label: CHECK_LABEL[r.check_key] ?? r.check_key,
      status: r.status,
      message: r.details?.message ?? null,
      refCount: Array.isArray(r.refs) ? r.refs.length : 0,
      ranAt: r.ran_at,
    }))
    // Failures first, then stale, then passing — surface what needs attention.
    .sort((a, b) => rank(a.status) - rank(b.status) || a.label.localeCompare(b.label));
}

function rank(status: string): number {
  return status === "fail" ? 0 : status === "stale" ? 1 : status === "skip" ? 2 : 3;
}
