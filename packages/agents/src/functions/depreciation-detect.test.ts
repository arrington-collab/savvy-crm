import { describe, it, expect } from "vitest";
import { withTenant, adminDb, tenant, customer, property, job, claim, invoice, jobChecklistItem, eq, and, DEPRECIATION_TASK_KEY } from "@savvy/db";
import { detectDepreciationForPaidInvoice } from "./depreciation-detect";

async function seed(opts: { type: "retail" | "insurance"; rcvCents?: number; acvCents?: number }) {
  const [t] = await adminDb.insert(tenant).values({ name: "dep", publicKey: `k-${Date.now()}-${Math.random()}`, clerkOrgId: `o-${Date.now()}-${Math.random()}` }).returning();
  const tid = t!.id;
  return withTenant(tid, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId: tid, name: "C" }).returning({ id: customer.id });
    const [p] = await tx.insert(property).values({ tenantId: tid, customerId: c!.id, address: "1 St" }).returning({ id: property.id });
    const [j] = await tx.insert(job).values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, type: opts.type, stage: "complete" }).returning({ id: job.id });
    if (opts.type === "insurance") {
      await tx.insert(claim).values({ tenantId: tid, jobId: j!.id, rcvCents: opts.rcvCents ?? null, acvCents: opts.acvCents ?? null, status: "approved" });
    }
    const [inv] = await tx.insert(invoice).values({ tenantId: tid, jobId: j!.id, status: "paid", amountDue: 1_000, amountPaid: 1_000 }).returning({ id: invoice.id });
    return { tid, jid: j!.id, invId: inv!.id };
  });
}

async function depTaskCount(tid: string, jid: string) {
  const rows = await withTenant(tid, (tx) => tx.select({ id: jobChecklistItem.id }).from(jobChecklistItem).where(and(eq(jobChecklistItem.jobId, jid), eq(jobChecklistItem.key, DEPRECIATION_TASK_KEY))));
  return rows.length;
}

describe("detectDepreciationForPaidInvoice", () => {
  it("creates the depreciation office task for a paid insurance invoice with recoverable depreciation", async () => {
    const { tid, jid, invId } = await seed({ type: "insurance", rcvCents: 2_000_000, acvCents: 1_400_000 });
    const r = await detectDepreciationForPaidInvoice(tid, invId);
    expect(r).toMatchObject({ depreciationCents: 600_000 });
    expect(await depTaskCount(tid, jid)).toBe(1);
  });

  it("does nothing for a retail invoice (lane branch)", async () => {
    const { tid, jid, invId } = await seed({ type: "retail" });
    const r = await detectDepreciationForPaidInvoice(tid, invId);
    expect(r).toEqual({ skipped: "not_insurance" });
    expect(await depTaskCount(tid, jid)).toBe(0);
  });

  it("skips when the invoice does not exist", async () => {
    const { tid } = await seed({ type: "retail" });
    const r = await detectDepreciationForPaidInvoice(tid, "00000000-0000-0000-0000-000000000000");
    expect(r).toEqual({ skipped: "no_invoice" });
  });
});
