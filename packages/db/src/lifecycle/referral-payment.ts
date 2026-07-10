import { and, eq } from "drizzle-orm";
import { withTenant } from "../tenant";
import { invoice, referralPayment } from "../schema/finance";
import { lead } from "../schema/crm";
import { job, jobChecklistItem } from "../schema/jobs";
import { tenant } from "../schema/tenancy";
import { parseReferralConfig, referralFeeRequiresApproval } from "@savvy/core";

/** Stable key for the "approve over-threshold referral fee" office task — also its idempotency guard. */
export const REFERRAL_FEE_APPROVAL_TASK_KEY = "finance.referral_fee_approval";

function formatUsd(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * On an invoice being paid, detect whether the underlying job originated from a
 * referral lead with a fee owed and, if so, record a `referral_payment` payable.
 * Fees at/under the tenant's configured approval threshold (or no threshold) are
 * auto-approved; fees over threshold are left pending and surface a one-tap
 * approval task in Needs-you. Idempotent per (tenant, job) via the unique index —
 * a redelivered invoice/paid event is deduped.
 */
export async function recordReferralPayment(input: {
  tenantId: string;
  invoiceId: string;
}): Promise<{ created: boolean; status?: string }> {
  return withTenant(input.tenantId, async (tx) => {
    const [inv] = await tx.select().from(invoice).where(eq(invoice.id, input.invoiceId));
    if (!inv) return { created: false };

    const [j] = await tx.select().from(job).where(eq(job.id, inv.jobId));
    if (!j?.leadId) return { created: false };

    const [l] = await tx.select().from(lead).where(eq(lead.id, j.leadId));
    if (!l || l.source !== "referral") return { created: false };

    const detail = (l.sourceDetail ?? {}) as { referrer_name?: string; referral_fee_cents?: number };
    const feeCents = detail.referral_fee_cents ?? 0;
    if (feeCents <= 0 || !detail.referrer_name) return { created: false };

    // Idempotency: one referral_payment per (tenant, job) — checked explicitly since
    // the insert below still relies on the unique index as the source of truth.
    const [existing] = await tx
      .select({ id: referralPayment.id })
      .from(referralPayment)
      .where(and(eq(referralPayment.tenantId, input.tenantId), eq(referralPayment.jobId, j.id)));
    if (existing) return { created: false };

    const [t] = await tx.select().from(tenant).where(eq(tenant.id, input.tenantId));
    const cfg = parseReferralConfig((t?.settings as { referral?: unknown })?.referral);
    const requiresApproval = referralFeeRequiresApproval(feeCents, cfg);
    const status = requiresApproval ? "pending" : "approved";

    const inserted = await tx
      .insert(referralPayment)
      .values({
        tenantId: input.tenantId,
        jobId: j.id,
        leadId: l.id,
        payeeName: detail.referrer_name,
        amountCents: feeCents,
        status,
      })
      .onConflictDoNothing()
      .returning({ id: referralPayment.id });
    if (inserted.length === 0) return { created: false };

    if (requiresApproval) {
      // Approval card, idempotent on (jobId, key) — no unique index on job_checklist_item,
      // so guard with an explicit existence check before inserting.
      const [existingCard] = await tx
        .select({ id: jobChecklistItem.id })
        .from(jobChecklistItem)
        .where(and(eq(jobChecklistItem.jobId, j.id), eq(jobChecklistItem.key, REFERRAL_FEE_APPROVAL_TASK_KEY)));
      if (!existingCard) {
        await tx.insert(jobChecklistItem).values({
          tenantId: input.tenantId,
          jobId: j.id,
          key: REFERRAL_FEE_APPROVAL_TASK_KEY,
          title: `Approve referral fee (${formatUsd(feeCents)}) to ${detail.referrer_name}`,
          status: "pending",
        });
      }
    }

    return { created: true, status };
  });
}
