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
import { recordReferralPayment, REFERRAL_FEE_APPROVAL_TASK_KEY } from "../src/lifecycle/referral-payment.js";
import { makeTenant } from "./helpers.js";

interface SeedOptions {
  feeCents: number;
  thresholdCents?: number | null;
  source?: string;
}

/** Creates a tenant, referral lead, job(leadId), paid invoice + payment. */
async function seedReferralJob(opts: SeedOptions): Promise<{ tenantId: string; invoiceId: string; jobId: string; leadId: string }> {
  const { tenantId } = await makeTenant();
  const source = opts.source ?? "referral";

  if (opts.thresholdCents !== undefined) {
    await adminDb
      .update(tenant)
      .set({ settings: { referral: { approvalThresholdCents: opts.thresholdCents } } })
      .where(eq(tenant.id, tenantId));
  }

  const [c] = await adminDb.insert(customer).values({ tenantId, name: "Test Customer" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "1 Test St" }).returning();
  const [l] = await adminDb
    .insert(lead)
    .values({
      tenantId,
      customerId: c!.id,
      propertyId: p!.id,
      source,
      sourceDetail: source === "referral" ? { referrer_name: "Jane Referrer", referral_fee_cents: opts.feeCents } : {},
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

  return { tenantId, invoiceId, jobId, leadId: l!.id };
}

describe("recordReferralPayment", () => {
  it("creates one approved payable for a referral job under threshold, idempotently", async () => {
    const { tenantId, invoiceId, jobId } = await seedReferralJob({ feeCents: 10000, thresholdCents: null });
    const r1 = await recordReferralPayment({ tenantId, invoiceId });
    const r2 = await recordReferralPayment({ tenantId, invoiceId }); // repeat invoice/paid
    const rows = await adminDb.select().from(referralPayment).where(eq(referralPayment.jobId, jobId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("approved");
    expect(rows[0]!.amountCents).toBe(10000);
    expect(r1.created).toBe(true);
    expect(r2.created).toBe(false);
  });

  it("over threshold → pending + approval card", async () => {
    const { tenantId, invoiceId, jobId } = await seedReferralJob({ feeCents: 30000, thresholdCents: 25000 });
    await recordReferralPayment({ tenantId, invoiceId });
    const [row] = await adminDb.select().from(referralPayment).where(eq(referralPayment.jobId, jobId));
    expect(row!.status).toBe("pending");

    const [card] = await adminDb
      .select()
      .from(jobChecklistItem)
      .where(and(eq(jobChecklistItem.jobId, jobId), eq(jobChecklistItem.key, REFERRAL_FEE_APPROVAL_TASK_KEY)));
    expect(card).toBeDefined();
    expect(card!.status).toBe("pending");
  });

  it("no payable for a non-referral job", async () => {
    const { tenantId, invoiceId, jobId } = await seedReferralJob({ feeCents: 0, source: "web" });
    await recordReferralPayment({ tenantId, invoiceId });
    const rows = await adminDb.select().from(referralPayment).where(eq(referralPayment.jobId, jobId));
    expect(rows).toHaveLength(0);
  });
});
