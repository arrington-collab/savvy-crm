import { describe, it, expect, beforeAll } from "vitest";
import { withTenant } from "../src/tenant.js";
import { commission, invoice } from "../src/schema/finance.js";
import { makeTenant, makeJobWithCustomer, makeUser } from "./helpers.js";

describe("commission table", () => {
  let tenantId: string, jobId: string, invoiceId: string, userId: string;

  beforeAll(async () => {
    ({ tenantId } = await makeTenant());
    ({ jobId } = await makeJobWithCustomer(tenantId));
    ({ userId } = await makeUser(tenantId));
    invoiceId = await withTenant(tenantId, async (tx) => {
      const [inv] = await tx
        .insert(invoice)
        .values({ tenantId, jobId, amountDue: 100000 })
        .returning({ id: invoice.id });
      return inv!.id;
    });
  });

  it("inserts and reads back a commission row, tenant-scoped", async () => {
    const row = await withTenant(tenantId, async (tx) => {
      const [r] = await tx
        .insert(commission)
        .values({
          tenantId,
          invoiceId,
          userId,
          model: "flat",
          basisCents: 100000,
          rate: 1000,
          amountCents: 10000,
          periodKey: "2026-06",
        })
        .returning();
      return r;
    });
    expect(row!.amountCents).toBe(10000);
    expect(row!.status).toBe("pending");
  });
});
