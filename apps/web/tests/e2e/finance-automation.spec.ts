import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  adminDb, tenant, customer, property, job, user, commission, communication,
  createInvoice, sendInvoice, recordStripePayment, eq, and,
} from "@savvy/db";
import { inngest } from "@savvy/agents";

const { id: tenantId } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string; key: string };

// Default commission config: flat model, 1000 bps = 10%.
// On a $2,500 invoice (250000 cents), commission = 25000 cents ($250).
const LINE_ITEMS = [
  { description: "Roof replacement", qty: 1, unitAmountCents: 200000 },
  { description: "Tear-off", qty: 2, unitAmountCents: 25000 },
];
const TOTAL_CENTS = 250000;
const EXPECTED_COMMISSION_CENTS = 25000; // 10% of $2,500

async function pollUntil<T>(
  fn: () => Promise<T | undefined>,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined && v !== null) return v;
    if (Date.now() > deadline) throw new Error("pollUntil: timed out");
    await new Promise((r) => setTimeout(r, 500));
  }
}

test("finance-automation: paid invoice triggers commission via Inngest; dunning does not fire", async ({
  page,
}) => {
  const stamp = randomUUID().slice(0, 8);

  // ── 1) Seed: tenant, rep user, customer, property, job with assignedUserId ──
  await adminDb.update(tenant)
    .set({ stripeAccountId: "acct_test" })
    .where(eq(tenant.id, tenantId));

  // Create a rep user owned by this tenant. The commission lookup uses userId
  // from job.assignedUserId → recordCommission skips when null.
  const [rep] = await adminDb.insert(user).values({
    tenantId,
    name: `Rep ${stamp}`,
    email: `rep-${stamp}@e2e.test`,
    role: "rep",
  }).returning();

  const [cust] = await adminDb.insert(customer).values({
    tenantId,
    name: `Commission Carl ${stamp}`,
    email: `carl-${stamp}@e2e.test`,
  }).returning();

  const [prop] = await adminDb.insert(property).values({
    tenantId,
    customerId: cust!.id,
    address: `${stamp} Commission Ave`,
  }).returning();

  // Assign the rep so recordCommission can find a userId.
  const [j] = await adminDb.insert(job).values({
    tenantId,
    customerId: cust!.id,
    propertyId: prop!.id,
    assignedUserId: rep!.id,
  }).returning();

  // ── 2) Create + send the invoice (drives invoice/sent → dunning run starts) ──
  const created = await createInvoice({ tenantId, jobId: j!.id, lineItems: LINE_ITEMS });
  expect(created.status).toBe("draft");
  const invoiceId = created.id;

  const sent = await sendInvoice({ tenantId, invoiceId });
  expect(sent.status).toBe("sent");

  // Fire invoice/sent so the dunning workflow registers (it will stay sleeping
  // until due+3 days and will be cancelled when we pay below).
  await inngest.send({ name: "invoice/sent", data: { invoiceId, tenantId } });

  // ── 3) Simulate Stripe payment (same mechanism as finance.spec.ts) ──────────
  const stripePaymentId = `pi_e2e_comm_${stamp}`;
  const r = await recordStripePayment({
    tenantId,
    invoiceId,
    stripePaymentId,
    method: "card",
    amountCents: TOTAL_CENTS,
  });
  expect(r.alreadyRecorded).toBe(false);
  expect(r.nowPaid).toBe(true);

  // Fire invoice/paid — this is what the Stripe webhook does after recordStripePayment.
  // It triggers commissionOnPaid (and cancels dunningRun via cancelOn).
  await inngest.send({ name: "invoice/paid", data: { invoiceId, tenantId } });

  // ── 4) Poll the DB for the commission row (Inngest dev processes async) ─────
  const commRow = await pollUntil(async () => {
    const rows = await adminDb
      .select()
      .from(commission)
      .where(and(eq(commission.tenantId, tenantId), eq(commission.invoiceId, invoiceId)));
    return rows[0];
  }, 30_000);

  expect(commRow.userId).toBe(rep!.id);
  expect(commRow.model).toBe("flat");
  expect(commRow.basisCents).toBe(TOTAL_CENTS);
  // Default rate is 1000 bps (10%). Store validates this.
  expect(commRow.rate).toBe(1000);
  expect(commRow.amountCents).toBe(EXPECTED_COMMISSION_CENTS);
  expect(commRow.status).toBe("pending");

  // ── 5) Navigate to /commissions and assert the UI row appears ────────────────
  await page.goto("/commissions");
  await expect(page.getByRole("heading", { name: "Commissions" })).toBeVisible();

  // The commission row card rendered by CommissionsClient has data-testid="commission-row".
  // Poll via page.waitForSelector because the page is server-rendered and the
  // commission row might not be present on first load if caching is stale.
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId("commission-row").first()).toBeVisible();
  }).toPass({ timeout: 15_000 });

  // Verify the amount displayed matches $250.00.
  await expect(page.getByTestId("commission-row").first()).toContainText("$250.00");

  // ── 6) Best-effort: no dunning communications were logged for this invoice ───
  // Dunning sleeps until dueAt+3 days (well in the future) before sending any
  // message, and cancelOn kills the run when invoice/paid fires. Either way,
  // no outbound dunning comms should exist for this customer yet.
  const dunningSent = await adminDb
    .select()
    .from(communication)
    .where(
      and(
        eq(communication.tenantId, tenantId),
        eq(communication.customerId, cust!.id),
        eq(communication.direction, "outbound"),
      ),
    );

  // Weak assertion: dunning should not have fired (dueAt is 14 days out).
  // We only assert that no dunning comm with a real body was sent.
  const dunningComms = dunningSent.filter(
    (c) => c.body && !c.body.startsWith("[suppressed"),
  );
  expect(dunningComms).toHaveLength(0);
});
