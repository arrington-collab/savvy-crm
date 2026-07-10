import { recordReferralPayment } from "@savvy/db";
import { inngest } from "../client";

/**
 * Fires on invoice/paid. Wraps the idempotent recordReferralPayment helper, which
 * detects a referral-sourced job and records (or skips) the payable — see
 * packages/db/src/lifecycle/referral-payment.ts for the full decision logic.
 */
export const referralFeeOnPaid = inngest.createFunction(
  { id: "referral-fee-on-paid", concurrency: { limit: 5 } },
  { event: "invoice/paid" },
  async ({ event, step }) => {
    const { tenantId, invoiceId } = event.data;
    const result = await step.run("record-referral-payment", async () =>
      recordReferralPayment({ tenantId, invoiceId }),
    );
    return { referral: result };
  },
);
