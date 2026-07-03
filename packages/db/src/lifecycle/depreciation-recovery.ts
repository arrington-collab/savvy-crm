import { and, eq } from "drizzle-orm";
import { job, claim, invoice, jobChecklistItem } from "../schema/index";
import { withTenant } from "../tenant";
import { recoverableDepreciationCents } from "@savvy/core";

/** Stable key for the depreciation-recovery office task — also its idempotency guard. */
export const DEPRECIATION_TASK_KEY = "claims.depreciation_recovery";
/** Stable key for the "send depreciation invoice to carrier" approval task. */
export const DEPRECIATION_APPROVAL_TASK_KEY = "claims.depreciation_invoice_approval";

const TASK_TITLE = "Update Xactimate pricing + prepare recovery invoice";

function formatUsd(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * On an insurance job's completion, detect recoverable depreciation and, if any,
 * generate the office-staff task (§G): "update the Xactimate pricing to current and
 * prepare the recovery invoice." The task is a `job_checklist_item` owned by the
 * claims agent, due immediately so it surfaces in the /exceptions "Needs you" list.
 * Idempotent per job (keyed by DEPRECIATION_TASK_KEY). Retail jobs are skipped — they
 * have no depreciation lane.
 */
export async function detectDepreciationRecovery(input: {
  tenantId: string;
  jobId: string;
  now?: Date;
}): Promise<{ created: string; depreciationCents: number } | { skipped: string }> {
  return withTenant(input.tenantId, async (tx) => {
    const [j] = await tx.select({ type: job.type }).from(job).where(eq(job.id, input.jobId));
    if (!j) return { skipped: "no_job" };
    if (j.type !== "insurance") return { skipped: "not_insurance" };

    const [c] = await tx.select({ rcvCents: claim.rcvCents, acvCents: claim.acvCents }).from(claim).where(eq(claim.jobId, input.jobId));
    if (!c) return { skipped: "no_claim" };

    const depreciationCents = recoverableDepreciationCents(c);
    if (depreciationCents <= 0) return { skipped: "no_depreciation" };

    const [existing] = await tx
      .select({ id: jobChecklistItem.id })
      .from(jobChecklistItem)
      .where(and(eq(jobChecklistItem.jobId, input.jobId), eq(jobChecklistItem.key, DEPRECIATION_TASK_KEY)));
    if (existing) return { skipped: "already_exists" };

    const now = input.now ?? new Date();
    const [row] = await tx
      .insert(jobChecklistItem)
      .values({
        tenantId: input.tenantId,
        jobId: input.jobId,
        key: DEPRECIATION_TASK_KEY,
        title: TASK_TITLE,
        phase: "closeout",
        ownerAgent: "claims",
        automationLevel: "manual", // the human does the Xactimate re-pricing judgment
        status: "pending",
        dueAt: now, // due now → surfaces immediately in the Needs-you queue
        payload: { recoverableDepreciationCents: depreciationCents },
      })
      .returning({ id: jobChecklistItem.id });

    return { created: row!.id, depreciationCents };
  });
}

/**
 * When the office staffer has updated the Xactimate pricing (the human judgment step),
 * auto-generate the depreciation-recovery invoice as a **draft** and queue a one-tap
 * "send to carrier" approval task in Needs-you (§G). Nothing goes to the carrier without
 * that approval. Optionally re-prices the claim's RCV from the updated Xactimate. The
 * detection task (if present) is marked done. Idempotent per job (the approval task guards).
 */
export async function draftDepreciationInvoice(input: {
  tenantId: string;
  jobId: string;
  updatedRcvCents?: number;
  now?: Date;
}): Promise<{ invoiceId: string; approvalTaskId: string; amountCents: number } | { skipped: string }> {
  return withTenant(input.tenantId, async (tx) => {
    const [j] = await tx.select({ type: job.type, customerId: job.customerId }).from(job).where(eq(job.id, input.jobId));
    if (!j) return { skipped: "no_job" };
    if (j.type !== "insurance") return { skipped: "not_insurance" };

    const [c] = await tx.select({ rcvCents: claim.rcvCents, acvCents: claim.acvCents }).from(claim).where(eq(claim.jobId, input.jobId));
    if (!c) return { skipped: "no_claim" };

    // Re-price the claim's RCV from the updated Xactimate, if provided.
    if (input.updatedRcvCents != null) {
      await tx.update(claim).set({ rcvCents: input.updatedRcvCents }).where(eq(claim.jobId, input.jobId));
    }
    const rcvCents = input.updatedRcvCents ?? c.rcvCents;
    const amountCents = recoverableDepreciationCents({ rcvCents, acvCents: c.acvCents });
    if (amountCents <= 0) return { skipped: "no_depreciation" };

    const [existing] = await tx
      .select({ id: jobChecklistItem.id })
      .from(jobChecklistItem)
      .where(and(eq(jobChecklistItem.jobId, input.jobId), eq(jobChecklistItem.key, DEPRECIATION_APPROVAL_TASK_KEY)));
    if (existing) return { skipped: "already_drafted" };

    const now = input.now ?? new Date();
    const [inv] = await tx
      .insert(invoice)
      .values({
        tenantId: input.tenantId,
        jobId: input.jobId,
        customerId: j.customerId ?? null,
        status: "draft", // held for approval — nothing to the carrier yet
        lineItems: [{ description: "Recoverable depreciation (carrier)", amountCents, quantity: 1 }],
        amountDue: amountCents,
      })
      .returning({ id: invoice.id });

    // Close the "update Xactimate + prep invoice" detection task — the human did that step.
    await tx
      .update(jobChecklistItem)
      .set({ status: "done", completedAt: now })
      .where(and(eq(jobChecklistItem.jobId, input.jobId), eq(jobChecklistItem.key, DEPRECIATION_TASK_KEY)));

    const [approval] = await tx
      .insert(jobChecklistItem)
      .values({
        tenantId: input.tenantId,
        jobId: input.jobId,
        key: DEPRECIATION_APPROVAL_TASK_KEY,
        title: `Send depreciation invoice to carrier (${formatUsd(amountCents)})`,
        phase: "billing",
        ownerAgent: "claims",
        automationLevel: "manual", // the human confirms the dollar document
        status: "pending",
        dueAt: now,
        payload: { invoiceId: inv!.id, amountCents },
      })
      .returning({ id: jobChecklistItem.id });

    return { invoiceId: inv!.id, approvalTaskId: approval!.id, amountCents };
  });
}

/**
 * The one-tap "send" on the approval task: flips the draft depreciation invoice to
 * `sent` and closes the approval task. Returns the jobId so the caller can emit
 * `invoice/sent` (QBO push, billing-stage advance). No-op if the invoice is not a draft.
 */
export async function sendDepreciationInvoice(input: {
  tenantId: string;
  jobId: string;
  invoiceId: string;
  now?: Date;
}): Promise<{ sent: true; jobId: string } | { skipped: string }> {
  return withTenant(input.tenantId, async (tx) => {
    const [inv] = await tx.select({ status: invoice.status }).from(invoice).where(eq(invoice.id, input.invoiceId));
    if (!inv) return { skipped: "no_invoice" };
    if (inv.status !== "draft") return { skipped: "not_draft" };

    await tx.update(invoice).set({ status: "sent" }).where(eq(invoice.id, input.invoiceId));
    await tx
      .update(jobChecklistItem)
      .set({ status: "done", completedAt: input.now ?? new Date() })
      .where(and(eq(jobChecklistItem.jobId, input.jobId), eq(jobChecklistItem.key, DEPRECIATION_APPROVAL_TASK_KEY)));
    return { sent: true, jobId: input.jobId };
  });
}
