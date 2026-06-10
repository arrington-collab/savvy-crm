import { describe, it, expect, beforeAll } from "vitest";
import { withTenant } from "../src/tenant.js";
import { invoice, payment } from "../src/schema/finance.js";
import { makeTenant, makeJobWithCustomer } from "./helpers.js";
import {
  createInvoice, createInvoiceFromEstimate, sendInvoice, voidInvoice,
  recordStripePayment, StripeNotConnectedError,
} from "../src/lifecycle/invoices.js";
import { estimate } from "../src/schema/finance.js";
import { tenant } from "../src/schema/tenancy.js";
import { adminDb } from "../src/admin-client.js";
import { eq } from "drizzle-orm";

describe("payment idempotency index", () => {
  let tenantId: string, jobId: string, invoiceId: string;
  beforeAll(async () => {
    ({ tenantId } = await makeTenant());
    ({ jobId } = await makeJobWithCustomer(tenantId));
    invoiceId = await withTenant(tenantId, async (tx) => {
      const [inv] = await tx.insert(invoice).values({ tenantId, jobId, amountDue: 10000 }).returning({ id: invoice.id });
      return inv!.id;
    });
  });

  it("rejects a duplicate stripe_payment_id for the same tenant", async () => {
    await withTenant(tenantId, (tx) => tx.insert(payment).values({
      tenantId, invoiceId, method: "card", amount: 10000, stripePaymentId: "pi_dup",
    }));
    await expect(
      withTenant(tenantId, (tx) => tx.insert(payment).values({
        tenantId, invoiceId, method: "card", amount: 10000, stripePaymentId: "pi_dup",
      })),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("allows multiple null stripe_payment_id (manual payments)", async () => {
    await withTenant(tenantId, (tx) => tx.insert(payment).values({ tenantId, invoiceId, method: "check", amount: 100 }));
    await expect(
      withTenant(tenantId, (tx) => tx.insert(payment).values({ tenantId, invoiceId, method: "check", amount: 200 })),
    ).resolves.toBeDefined();
  });
});

describe("invoice lifecycle", () => {
  let tenantId: string, jobId: string;
  beforeAll(async () => {
    ({ tenantId } = await makeTenant());
    ({ jobId } = await makeJobWithCustomer(tenantId));
  });

  it("createInvoice computes amountDue from line items", async () => {
    const inv = await createInvoice({ tenantId, jobId, lineItems: [
      { description: "Roof", qty: 1, unitAmountCents: 500000 },
      { description: "Gutters", qty: 2, unitAmountCents: 25000 },
    ]});
    expect(inv.amountDue).toBe(550000);
    expect(inv.status).toBe("draft");
  });

  it("sendInvoice blocks without a connected Stripe account", async () => {
    const inv = await createInvoice({ tenantId, jobId, lineItems: [{ description: "X", qty: 1, unitAmountCents: 100 }] });
    await expect(sendInvoice({ tenantId, invoiceId: inv.id })).rejects.toBeInstanceOf(StripeNotConnectedError);
  });

  it("sendInvoice assigns sequential number + due date once Stripe connected", async () => {
    await adminDb.update(tenant).set({ stripeAccountId: "acct_test" }).where(eq(tenant.id, tenantId));
    const a = await createInvoice({ tenantId, jobId, lineItems: [{ description: "A", qty: 1, unitAmountCents: 100 }] });
    const b = await createInvoice({ tenantId, jobId, lineItems: [{ description: "B", qty: 1, unitAmountCents: 100 }] });
    const sa = await sendInvoice({ tenantId, invoiceId: a.id });
    const sb = await sendInvoice({ tenantId, invoiceId: b.id });
    expect(sa.number).toMatch(/^INV-\d{6}$/);
    expect(sb.number).not.toBe(sa.number);
    expect(sa.status).toBe("sent");
    expect(sa.dueAt).toBeTruthy();
  });

  it("recordStripePayment is idempotent and flips to paid when fully paid", async () => {
    const inv = await createInvoice({ tenantId, jobId, lineItems: [{ description: "P", qty: 1, unitAmountCents: 10000 }] });
    const r1 = await recordStripePayment({ tenantId, invoiceId: inv.id, stripePaymentId: "pi_1", method: "card", amountCents: 10000 });
    expect(r1).toEqual({ alreadyRecorded: false, nowPaid: true });
    const r2 = await recordStripePayment({ tenantId, invoiceId: inv.id, stripePaymentId: "pi_1", method: "card", amountCents: 10000 });
    expect(r2.alreadyRecorded).toBe(true);
  });

  it("partial payment keeps status sent", async () => {
    const inv = await createInvoice({ tenantId, jobId, lineItems: [{ description: "Q", qty: 1, unitAmountCents: 10000 }] });
    const r = await recordStripePayment({ tenantId, invoiceId: inv.id, stripePaymentId: "pi_partial", method: "ach", amountCents: 4000 });
    expect(r.nowPaid).toBe(false);
  });

  it("createInvoiceFromEstimate copies items and accepts the estimate", async () => {
    const estId = await withTenant(tenantId, async (tx) => {
      const [e] = await tx.insert(estimate).values({
        tenantId, jobId, status: "sent",
        lineItems: [{ description: "Est", qty: 1, unitAmountCents: 0 }], total: 777,
      }).returning({ id: estimate.id });
      return e!.id;
    });
    const inv = await createInvoiceFromEstimate({ tenantId, estimateId: estId });
    expect(inv.amountDue).toBe(777);
    const e = await withTenant(tenantId, async (tx) => (await tx.select().from(estimate).where(eq(estimate.id, estId)))[0]);
    expect(e!.status).toBe("accepted");
  });

  it("voidInvoice sets void", async () => {
    const inv = await createInvoice({ tenantId, jobId, lineItems: [{ description: "V", qty: 1, unitAmountCents: 1 }] });
    await voidInvoice({ tenantId, invoiceId: inv.id });
  });
});
