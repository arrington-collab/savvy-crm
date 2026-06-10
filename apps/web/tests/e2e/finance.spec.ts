import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  adminDb, tenant, customer, property, job, invoice, payment,
  createInvoice, sendInvoice, recordStripePayment, eq, and,
} from "@savvy/db";

const { id: tenantId } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string; key: string };

// 250000 cents = $2,500.00. Two line items so qty*unit math is exercised.
const LINE_ITEMS = [
  { description: "Roof replacement", qty: 1, unitAmountCents: 200000 },
  { description: "Tear-off", qty: 2, unitAmountCents: 25000 },
];
const TOTAL_CENTS = 250000;

test("finance: create -> send (sequential number) -> reconcile -> paid (idempotent)", async ({
  page,
}) => {
  const stamp = randomUUID().slice(0, 8);

  // ---- 1) Setup fixtures via adminDb against the e2e tenant ---------------
  // sendInvoice requires a connected Stripe account on the tenant.
  await adminDb.update(tenant)
    .set({ stripeAccountId: "acct_test" })
    .where(eq(tenant.id, tenantId));

  const [cust] = await adminDb.insert(customer).values({
    tenantId, name: `Paying Pat ${stamp}`, email: `pat-${stamp}@e2e.test`,
  }).returning();

  const [prop] = await adminDb.insert(property).values({
    tenantId, customerId: cust!.id, address: `${stamp} Money Path Ln`,
  }).returning();

  const [j] = await adminDb.insert(job).values({
    tenantId, customerId: cust!.id, propertyId: prop!.id,
  }).returning();

  // ---- 2) Create the invoice + assert it lists as a draft ----------------
  const created = await createInvoice({ tenantId, jobId: j!.id, lineItems: LINE_ITEMS });
  expect(created.amountDue).toBe(TOTAL_CENTS);
  expect(created.status).toBe("draft");
  expect(created.number).toBeNull();
  const invoiceId = created.id;

  await page.goto("/invoices");
  await expect(page.getByRole("heading", { name: "Invoices" })).toBeVisible();
  const draftRow = page.locator(
    `[data-testid="invoice-row"][data-invoice-id="${invoiceId}"]`,
  );
  await expect(draftRow).toBeVisible();
  // A draft has no number — the list renders "Draft" + the customer name.
  await expect(draftRow).toContainText("Draft");
  await expect(draftRow).toContainText(cust!.name);

  // ---- 3) Send: gets a sequential INV- number + "sent" status ------------
  const sent = await sendInvoice({ tenantId, invoiceId });
  expect(sent.status).toBe("sent");
  expect(sent.number).toMatch(/^INV-\d{6}$/);
  const invNumber = sent.number!;

  await page.goto(`/invoices/${invoiceId}`);
  await expect(page.getByTestId("invoice-number")).toHaveText(invNumber);
  await expect(page.getByTestId("invoice-status")).toHaveText("sent");

  // ---- 4) Reconcile: simulate the Stripe webhook by calling the exact -----
  // code the webhook runs. Invoice flips to paid; the payment is listed.
  const first = await recordStripePayment({
    tenantId, invoiceId, stripePaymentId: "pi_e2e", method: "card", amountCents: TOTAL_CENTS,
  });
  expect(first.alreadyRecorded).toBe(false);
  expect(first.nowPaid).toBe(true);

  await page.goto(`/invoices/${invoiceId}`);
  await expect(page.getByTestId("invoice-status")).toHaveText("paid");
  const paymentRow = page.getByTestId("payment-row");
  await expect(paymentRow).toHaveCount(1);
  await expect(paymentRow).toContainText("$2,500.00");
  await expect(paymentRow).toContainText("card");

  // DB-backed assertion: invoice is paid + fully credited.
  const [paidInv] = await adminDb.select().from(invoice).where(eq(invoice.id, invoiceId));
  expect(paidInv!.status).toBe("paid");
  expect(paidInv!.amountPaid).toBe(TOTAL_CENTS);

  // ---- 5) Idempotency: same pi_e2e must NOT create a second payment ------
  const second = await recordStripePayment({
    tenantId, invoiceId, stripePaymentId: "pi_e2e", method: "card", amountCents: TOTAL_CENTS,
  });
  expect(second.alreadyRecorded).toBe(true);

  const rows = await adminDb.select().from(payment)
    .where(and(eq(payment.tenantId, tenantId), eq(payment.invoiceId, invoiceId)));
  expect(rows).toHaveLength(1);

  // Amount paid did not double up.
  const [stillPaid] = await adminDb.select().from(invoice).where(eq(invoice.id, invoiceId));
  expect(stillPaid!.amountPaid).toBe(TOTAL_CENTS);
});
