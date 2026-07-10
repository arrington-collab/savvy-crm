"use server";
import { revalidatePath } from "next/cache";
import { approveReferralPayment } from "@savvy/db";
import { getTenantId } from "./tenant";

/**
 * The one-tap "approve" on the over-threshold referral-fee approval card: flips the
 * pending referral_payment to approved and closes the approval task. Modeled on
 * `sendDepreciationInvoiceAction` in claim-actions.ts.
 */
export async function approveReferralPaymentAction(input: { jobId: string }) {
  const tenantId = await getTenantId();
  const r = await approveReferralPayment({ tenantId, jobId: input.jobId });
  revalidatePath(`/jobs/${input.jobId}`);
  if ("skipped" in r) return { error: r.skipped as string };
  return { ok: true as const };
}
