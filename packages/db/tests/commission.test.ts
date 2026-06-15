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

  it("enforces one commission per invoice (idempotency key)", async () => {
    // Fresh tenant + job + invoice so this test is independent of the shared beforeAll state
    const { tenantId: t2 } = await makeTenant();
    const { jobId: j2 } = await makeJobWithCustomer(t2);
    const { userId: userA } = await makeUser(t2);
    const { userId: userB } = await makeUser(t2);

    const inv2Id = await withTenant(t2, async (tx) => {
      const [inv] = await tx
        .insert(invoice)
        .values({ tenantId: t2, jobId: j2, amountDue: 50000 })
        .returning({ id: invoice.id });
      return inv!.id;
    });

    // First insert (userA) must succeed
    await withTenant(t2, async (tx) => {
      await tx.insert(commission).values({
        tenantId: t2,
        invoiceId: inv2Id,
        userId: userA,
        model: "flat",
        basisCents: 50000,
        rate: 1000,
        amountCents: 500,
        periodKey: "2026-06",
      });
    });

    // Second insert for the SAME (tenantId, invoiceId) with a different user must be rejected
    await expect(
      withTenant(t2, async (tx) => {
        await tx.insert(commission).values({
          tenantId: t2,
          invoiceId: inv2Id,
          userId: userB,
          model: "flat",
          basisCents: 5000,
          rate: 1000,
          amountCents: 500,
          periodKey: "2026-06",
        });
      }),
    ).rejects.toThrow();
  });
});
