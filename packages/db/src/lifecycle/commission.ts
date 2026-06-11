import { withTenant } from "../tenant";
import { invoice, payment, commission } from "../schema/finance";
import { job } from "../schema/jobs";
import { tenant } from "../schema/tenancy";
import { and, eq, sql } from "drizzle-orm";
import { parseFinanceConfig, computeCommission } from "@savvy/core";

function periodKeyFor(date: Date, period: "monthly" | "quarterly"): string {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth(); // 0-based
  if (period === "quarterly") return `${y}-Q${Math.floor(m / 3) + 1}`;
  return `${y}-${String(m + 1).padStart(2, "0")}`;
}

export async function recordCommission(input: {
  tenantId: string;
  invoiceId: string;
}): Promise<{ amountCents: number; alreadyRecorded: boolean } | null> {
  return withTenant(input.tenantId, async (tx) => {
    const [inv] = await tx.select().from(invoice).where(eq(invoice.id, input.invoiceId));
    if (!inv) return null;

    // Idempotency check — one commission row per (tenant, invoice)
    const existing = await tx
      .select({ id: commission.id })
      .from(commission)
      .where(and(eq(commission.tenantId, input.tenantId), eq(commission.invoiceId, input.invoiceId)));
    if (existing.length > 0) return { amountCents: 0, alreadyRecorded: true };

    const [j] = await tx.select().from(job).where(eq(job.id, inv.jobId));
    const repId = j?.assignedUserId;
    if (!repId) return null; // no rep assigned → skip silently

    const [t] = await tx.select().from(tenant).where(eq(tenant.id, input.tenantId));
    const cfg = parseFinanceConfig((t?.settings as { finance?: unknown })?.finance).commission;
    // Per-rep override takes precedence over the global rate
    const rate = cfg.perRepRate[repId] ?? cfg.rate;

    let basisCents = inv.amountPaid ?? 0;
    if (cfg.model === "profit") {
      // Profit model: basis is (paid - cost). Skip if cost is unknown.
      if (j?.costCents == null) return null;
      basisCents = (inv.amountPaid ?? 0) - j.costCents;
    }

    // Use the most recent payment's timestamp to assign the period key
    const [pmt] = await tx
      .select()
      .from(payment)
      .where(eq(payment.invoiceId, input.invoiceId))
      .orderBy(sql`received_at desc`)
      .limit(1);
    const periodKey = periodKeyFor(pmt?.receivedAt ?? new Date(), cfg.period);

    // Sum up the rep's basis already booked this period for tiered rate lookup
    const priorRows = await tx
      .select({ prior: sql<number>`coalesce(sum(basis_cents), 0)::int` })
      .from(commission)
      .where(
        and(
          eq(commission.tenantId, input.tenantId),
          eq(commission.userId, repId),
          eq(commission.periodKey, periodKey),
        ),
      );
    const priorPeriodTotalCents = priorRows[0]?.prior ?? 0;

    const { amountCents, appliedRate } = computeCommission({
      model: cfg.model,
      basisCents,
      rate,
      tiers: cfg.tiers,
      priorPeriodTotalCents,
    });

    await tx
      .insert(commission)
      .values({
        tenantId: input.tenantId,
        invoiceId: input.invoiceId,
        userId: repId,
        model: cfg.model,
        basisCents,
        rate: appliedRate,
        amountCents,
        periodKey,
        status: "pending",
      })
      .onConflictDoNothing();

    return { amountCents, alreadyRecorded: false };
  });
}
