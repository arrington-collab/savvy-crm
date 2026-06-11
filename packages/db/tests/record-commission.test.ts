import { describe, it, expect } from "vitest";
import { adminDb } from "../src/admin-client.js";
import { withTenant } from "../src/tenant.js";
import { commission, invoice, payment } from "../src/schema/finance.js";
import { job } from "../src/schema/jobs.js";
import { tenant } from "../src/schema/tenancy.js";
import { eq } from "drizzle-orm";
import { makeTenant, makeUser, makeJobWithCustomer } from "./helpers.js";
import { recordCommission } from "../src/lifecycle/commission.js";

interface PaidInvoiceOptions {
  amountPaidCents: number;
  assignRep: boolean;
  model?: "flat" | "profit" | "tiered";
  costCents?: number | null;
  receivedAt?: Date;
}

/** Creates a tenant (with optional finance commission settings), a job, an invoice, and a payment row. */
async function makePaidInvoice(opts: PaidInvoiceOptions): Promise<{ tenantId: string; invoiceId: string }> {
  const { tenantId } = await makeTenant();
  const { jobId } = await makeJobWithCustomer(tenantId);

  // Set finance commission config on the tenant when a specific model is requested
  if (opts.model && opts.model !== "flat") {
    await adminDb
      .update(tenant)
      .set({ settings: { finance: { commission: { model: opts.model } } } })
      .where(eq(tenant.id, tenantId));
  }

  let userId: string | undefined;
  if (opts.assignRep) {
    ({ userId } = await makeUser(tenantId));
    // Attach the rep to the job
    await adminDb.update(job).set({ assignedUserId: userId }).where(eq(job.id, jobId));
  }

  // Set costCents on the job when specified (null means "leave it null" for profit-without-cost test)
  if (opts.costCents !== undefined && opts.costCents !== null) {
    await adminDb.update(job).set({ costCents: opts.costCents }).where(eq(job.id, jobId));
  }

  // Create an invoice with amountPaid already set (simulating a fully-paid invoice)
  const invoiceId = await withTenant(tenantId, async (tx) => {
    const [inv] = await tx
      .insert(invoice)
      .values({
        tenantId,
        jobId,
        amountDue: opts.amountPaidCents,
        amountPaid: opts.amountPaidCents,
        status: "paid",
      })
      .returning({ id: invoice.id });
    return inv!.id;
  });

  // Insert a corresponding payment row so periodKey lookup has a timestamp
  await withTenant(tenantId, (tx) =>
    tx.insert(payment).values({
      tenantId,
      invoiceId,
      method: "check",
      amount: opts.amountPaidCents,
      ...(opts.receivedAt !== undefined ? { receivedAt: opts.receivedAt } : {}),
    }),
  );

  return { tenantId, invoiceId };
}

describe("recordCommission", () => {
  it("computes flat commission on a paid invoice and is idempotent", async () => {
    // Default tenant settings → parseFinanceConfig defaults → flat model, rate=1000 (10%)
    const { tenantId, invoiceId } = await makePaidInvoice({ amountPaidCents: 100_000, assignRep: true });

    const a = await recordCommission({ tenantId, invoiceId });
    expect(a).not.toBeNull();
    expect(a?.alreadyRecorded).toBe(false);
    // 100_000 * 1000 bps / 10_000 = 10_000 cents
    expect(a?.amountCents).toBe(10_000);

    // Second call must no-op (idempotency)
    const b = await recordCommission({ tenantId, invoiceId });
    expect(b?.alreadyRecorded).toBe(true);

    // DB must have exactly one commission row
    const rows = await withTenant(tenantId, (tx) =>
      tx.select().from(commission).where(eq(commission.invoiceId, invoiceId)),
    );
    expect(rows).toHaveLength(1);
  });

  it("skips (returns null) when the job has no assigned rep", async () => {
    const { tenantId, invoiceId } = await makePaidInvoice({ amountPaidCents: 100_000, assignRep: false });
    const result = await recordCommission({ tenantId, invoiceId });
    expect(result).toBeNull();
  });

  it("skips (returns null) for profit model when job.costCents is null", async () => {
    // model = "profit", costCents intentionally left null
    const { tenantId, invoiceId } = await makePaidInvoice({
      amountPaidCents: 100_000,
      assignRep: true,
      model: "profit",
      costCents: null,
    });
    const result = await recordCommission({ tenantId, invoiceId });
    expect(result).toBeNull();
  });

  it("buckets period key by tenant timezone (Phoenix), not UTC", async () => {
    // 2026-01-01T03:00:00Z = 2025-12-31 20:00 in America/Phoenix (UTC-7, no DST)
    // UTC would give periodKey "2026-01"; Phoenix local should give "2025-12"
    const { tenantId, invoiceId } = await makePaidInvoice({
      amountPaidCents: 100_000,
      assignRep: true,
      receivedAt: new Date("2026-01-01T03:00:00Z"),
    });
    await recordCommission({ tenantId, invoiceId });
    const [row] = await withTenant(tenantId, (tx) =>
      tx.select().from(commission).where(eq(commission.invoiceId, invoiceId)),
    );
    expect(row?.periodKey).toBe("2025-12"); // Phoenix local = Dec 31, not Jan (UTC)
  });
});
