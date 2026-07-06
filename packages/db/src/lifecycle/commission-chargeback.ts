import { and, eq, inArray } from "drizzle-orm";
import { commission, invoice } from "../schema/finance";
import { db } from "../client";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Charges back a job's commissions when the job is cancelled / called back
 * (stage → 'lost'). Commissions not yet paid out (pending/approved) flip to
 * 'charged_back'; commissions already PAID are left as-is and only counted —
 * the money has left the building, so a paid clawback is a manual, owner-approved
 * action, never a silent reversal. Runs inside the caller's stage-change tx.
 */
export async function chargebackCommissionsForJob(
  tx: Tx,
  opts: { tenantId: string; jobId: string },
): Promise<{ chargedBack: number; paidNeedingClawback: number }> {
  const invRows = await tx
    .select({ id: invoice.id })
    .from(invoice)
    .where(and(eq(invoice.tenantId, opts.tenantId), eq(invoice.jobId, opts.jobId)));
  const invIds = invRows.map((r) => r.id);
  if (invIds.length === 0) return { chargedBack: 0, paidNeedingClawback: 0 };

  const paid = await tx
    .select({ id: commission.id })
    .from(commission)
    .where(and(eq(commission.tenantId, opts.tenantId), inArray(commission.invoiceId, invIds), eq(commission.status, "paid")));

  const flipped = await tx
    .update(commission)
    .set({ status: "charged_back" })
    .where(
      and(
        eq(commission.tenantId, opts.tenantId),
        inArray(commission.invoiceId, invIds),
        inArray(commission.status, ["pending", "approved"]),
      ),
    )
    .returning({ id: commission.id });

  return { chargedBack: flipped.length, paidNeedingClawback: paid.length };
}
