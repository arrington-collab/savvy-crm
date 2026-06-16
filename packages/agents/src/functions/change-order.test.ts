import { describe, it, expect } from "vitest";
import { adminDb, withTenant, eq, tenant, customer, property, job, invoice, agentRun, createChangeOrder } from "@savvy/db";
import { makeFakeStripe } from "@savvy/integrations";
import { applyAcceptedChangeOrder, autoSendSupplementalInvoice } from "./change-order";

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

describe("autoSendSupplementalInvoice", () => {
  it("sends a draft supplemental invoice: number, checkout, dunning-ready, finance/ok run", async () => {
    const { tenantId, jobId, changeOrderId } = await seed(50000);
    await adminDb.update(tenant).set({ stripeAccountId: "acct_test" }).where(eq(tenant.id, tenantId));
    const applied = await applyAcceptedChangeOrder(tenantId, changeOrderId);
    expect(applied.invoiceId).toBeTruthy();

    const fake = makeFakeStripe();
    const res = await autoSendSupplementalInvoice({ tenantId, invoiceId: applied.invoiceId }, { stripe: fake });
    expect(res.sent).toBe(true);

    const [inv] = await adminDb.select().from(invoice).where(eq(invoice.jobId, jobId));
    expect(inv!.status).toBe("sent");
    expect(inv!.number).toBeTruthy();
    expect(inv!.stripeCheckoutSessionId).toBeTruthy();
    expect(fake.calls.some((c) => c.op === "checkout")).toBe(true);

    const runs = await adminDb.select().from(agentRun).where(eq(agentRun.tenantId, tenantId));
    expect(runs.some((r) => r.agent === "finance" && r.taskKey === "change-order.auto-send-invoice" && r.status === "ok")).toBe(true);

    const res2 = await autoSendSupplementalInvoice({ tenantId, invoiceId: applied.invoiceId }, { stripe: fake });
    expect(res2).toEqual({ sent: false, reason: "already-sent" });
    const invs = await adminDb.select().from(invoice).where(eq(invoice.jobId, jobId));
    expect(invs.length).toBe(1);
  });

  it("does not send (no Stripe call) when the invoice amount is non-positive", async () => {
    const { tenantId, jobId, changeOrderId } = await seed(50000);
    await adminDb.update(tenant).set({ stripeAccountId: "acct_test" }).where(eq(tenant.id, tenantId));
    const applied = await applyAcceptedChangeOrder(tenantId, changeOrderId);
    // Force a non-positive amount on the draft invoice.
    await adminDb.update(invoice).set({ amountDue: 0 }).where(eq(invoice.id, applied.invoiceId!));

    const fake = makeFakeStripe();
    const res = await autoSendSupplementalInvoice({ tenantId, invoiceId: applied.invoiceId }, { stripe: fake });
    expect(res).toEqual({ sent: false, reason: "already-sent" });
    expect(fake.calls.some((c) => c.op === "checkout")).toBe(false);
    const [inv] = await adminDb.select().from(invoice).where(eq(invoice.jobId, jobId));
    expect(inv!.status).toBe("sent"); // sendInvoice already flipped it; we just don't charge $0
  });

  it("skips (no throw) when the tenant has no Stripe account; logs finance/skipped", async () => {
    const { tenantId, jobId, changeOrderId } = await seed(50000);
    const applied = await applyAcceptedChangeOrder(tenantId, changeOrderId);
    const res = await autoSendSupplementalInvoice({ tenantId, invoiceId: applied.invoiceId }, { stripe: makeFakeStripe() });
    expect(res).toEqual({ sent: false, reason: "stripe-not-connected" });
    const [inv] = await adminDb.select().from(invoice).where(eq(invoice.jobId, jobId));
    expect(inv!.status).toBe("draft");
    const runs = await adminDb.select().from(agentRun).where(eq(agentRun.tenantId, tenantId));
    expect(runs.some((r) => r.agent === "finance" && r.status === "skipped")).toBe(true);
  });
});
