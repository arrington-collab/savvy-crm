import { describe, it, expect } from "vitest";
import { adminDb } from "../src/admin-client.js";
import { withTenant } from "../src/tenant.js";
import { referralPayment, invoice, payment } from "../src/schema/finance.js";
import { job } from "../src/schema/jobs.js";
import { lead } from "../src/schema/crm.js";
import { jobChecklistItem } from "../src/schema/jobs.js";
import { tenant } from "../src/schema/tenancy.js";
import { customer, property } from "../src/schema/index.js";
import { eq, and } from "drizzle-orm";
import {
  recordReferralPayment,
  approveReferralPayment,
  REFERRAL_FEE_APPROVAL_TASK_KEY,
} from "../src/lifecycle/referral-payment.js";
import { makeTenant } from "./helpers.js";

/** Creates a tenant, over-threshold referral lead, job(leadId), paid invoice + payment,
 * then records the referral payable — leaving a pending payable + approval card. */
async function seedPendingReferralPayment(): Promise<{ tenantId: string; jobId: string }> {
  const { tenantId } = await makeTenant();

  await adminDb
    .update(tenant)
    .set({ settings: { referral: { approvalThresholdCents: 25000 } } })
    .where(eq(tenant.id, tenantId));

  const [c] = await adminDb.insert(customer).values({ tenantId, name: "Test Customer" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "1 Test St" }).returning();
  const [l] = await adminDb
    .insert(lead)
    .values({
      tenantId,
      customerId: c!.id,
      propertyId: p!.id,
      source: "referral",
      sourceDetail: { referrer_name: "Jane Referrer", referral_fee_cents: 30000 },
    })
    .returning();

  const jobId = await withTenant(tenantId, async (tx) => {
    const [j] = await tx
      .insert(job)
      .values({ tenantId, customerId: c!.id, propertyId: p!.id, leadId: l!.id, type: "retail", stage: "lead" })
      .returning({ id: job.id });
    return j!.id;
  });

  const invoiceId = await withTenant(tenantId, async (tx) => {
    const [inv] = await tx
      .insert(invoice)
      .values({ tenantId, jobId, amountDue: 100_000, amountPaid: 100_000, status: "paid" })
      .returning({ id: invoice.id });
    return inv!.id;
  });

  await withTenant(tenantId, (tx) =>
    tx.insert(payment).values({ tenantId, invoiceId, method: "check", amount: 100_000 }),
  );

  await recordReferralPayment({ tenantId, invoiceId });

  return { tenantId, jobId };
}

describe("approveReferralPayment", () => {
  it("flips the pending payable to approved and resolves the approval card", async () => {
    const { tenantId, jobId } = await seedPendingReferralPayment();

    const [before] = await adminDb.select().from(referralPayment).where(eq(referralPayment.jobId, jobId));
    expect(before!.status).toBe("pending");

    await approveReferralPayment({ tenantId, jobId });

    const [after] = await adminDb.select().from(referralPayment).where(eq(referralPayment.jobId, jobId));
    expect(after!.status).toBe("approved");

    const [card] = await adminDb
      .select()
      .from(jobChecklistItem)
      .where(and(eq(jobChecklistItem.jobId, jobId), eq(jobChecklistItem.key, REFERRAL_FEE_APPROVAL_TASK_KEY)));
    expect(card!.status).toBe("done");
    expect(card!.completedAt).not.toBeNull();
  });
});
