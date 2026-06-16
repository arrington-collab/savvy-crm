import { describe, it, expect } from "vitest";
import { adminDb, withTenant, eq, tenant, customer, property, job, invoice, changeOrder, createChangeOrder } from "@savvy/db";
import { applyAcceptedChangeOrder } from "./change-order";

async function seed(total: number): Promise<{ tenantId: string; jobId: string; changeOrderId: string }> {
  const [t] = await adminDb.insert(tenant).values({ name: "COA", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}` }).returning();
  const [c] = await adminDb.insert(customer).values({ tenantId: t!.id, name: "Sam", email: "sam@x.com" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId: t!.id, customerId: c!.id, address: "9 St" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId: t!.id, customerId: c!.id, propertyId: p!.id, valueFinal: 100000 }).returning();
  const co = await createChangeOrder({ tenantId: t!.id, jobId: j!.id, customerId: c!.id, reason: "r", lineItems: [{ amountCents: total }] });
  return { tenantId: t!.id, jobId: j!.id, changeOrderId: co.id };
}

describe("applyAcceptedChangeOrder", () => {
  it("approves once (value bump + draft invoice) and is idempotent", async () => {
    const { tenantId, jobId, changeOrderId } = await seed(30000);
    const r1 = await applyAcceptedChangeOrder(tenantId, changeOrderId);
    expect(r1.invoiceCreated).toBe(true);
    const [j1] = await withTenant(tenantId, (tx) => tx.select().from(job).where(eq(job.id, jobId)));
    expect(j1!.valueFinal).toBe(130000);
    const invs = await adminDb.select().from(invoice).where(eq(invoice.jobId, jobId));
    expect(invs.length).toBe(1);

    const r2 = await applyAcceptedChangeOrder(tenantId, changeOrderId);
    expect(r2.invoiceCreated).toBe(false);
    const invs2 = await adminDb.select().from(invoice).where(eq(invoice.jobId, jobId));
    expect(invs2.length).toBe(1);
  });
});
