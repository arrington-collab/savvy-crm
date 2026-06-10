import { describe, it, expect, beforeAll } from "vitest";
import { withTenant } from "../src/tenant.js";
import { invoice, payment } from "../src/schema/finance.js";
import { makeTenant, makeJobWithCustomer } from "./helpers.js";

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
