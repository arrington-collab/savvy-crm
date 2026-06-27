import { describe, it, expect } from "vitest";
import { withTenant, adminDb, tenant, customer, property, job, invoice, eq } from "@savvy/db";
import { type JobStage } from "@savvy/core";
import { syncInvoiceStage } from "./invoice-stage";

async function seedJobAt(stage: JobStage) {
  const [t] = await adminDb.insert(tenant).values({ name: "inv", publicKey: `k-${Date.now()}-${Math.random()}`, clerkOrgId: `o-${Date.now()}-${Math.random()}` }).returning();
  const tid = t!.id;
  const ids = await withTenant(tid, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId: tid, name: "C" }).returning({ id: customer.id });
    const [p] = await tx.insert(property).values({ tenantId: tid, customerId: c!.id, address: "1 St" }).returning({ id: property.id });
    const [j] = await tx.insert(job).values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, type: "retail", stage }).returning({ id: job.id });
    const [inv] = await tx.insert(invoice).values({ tenantId: tid, jobId: j!.id, status: "sent", amountDue: 1000 }).returning({ id: invoice.id });
    return { jid: j!.id, invId: inv!.id };
  });
  return { tid, ...ids };
}

describe("syncInvoiceStage", () => {
  it("advances closeout → billing on invoice/sent", async () => {
    const { tid, jid, invId } = await seedJobAt("closeout");
    const r = await syncInvoiceStage(tid, invId, "billing");
    expect(r).toMatchObject({ jobId: jid, toStage: "billing" });
    const [j] = await adminDb.select({ stage: job.stage }).from(job).where(eq(job.id, jid));
    expect(j!.stage).toBe("billing");
  });
  it("is forward-only: does not pull a complete job back to billing", async () => {
    const { tid, invId, jid } = await seedJobAt("complete");
    const r = await syncInvoiceStage(tid, invId, "billing");
    expect(r).toMatchObject({ skipped: "not_forward" });
    const [j] = await adminDb.select({ stage: job.stage }).from(job).where(eq(job.id, jid));
    expect(j!.stage).toBe("complete");
  });
  it("returns skipped: no_invoice when the invoice does not exist", async () => {
    const [t] = await adminDb.insert(tenant).values({ name: "no-inv", publicKey: `k-${Date.now()}-${Math.random()}`, clerkOrgId: `o-${Date.now()}-${Math.random()}` }).returning();
    const tid = t!.id;
    const r = await syncInvoiceStage(tid, "00000000-0000-0000-0000-000000000000", "billing");
    expect(r).toEqual({ skipped: "no_invoice" });
  });
});
