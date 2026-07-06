import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { makeQbReconcileCheck, makeStripeMatchCheck } from "@savvy/core";
import type { EvidenceCtx } from "@savvy/core";
import { adminDb, adminPool } from "../src/admin-client.js";
import { tenant, customer, property, invoice, payment, job } from "../src/schema/index.js";

// Cell 8 money reconciliation: Savvy AR == QuickBooks AR; Stripe collected ==
// payments ledger. Fail-soft — a vendor error is `stale`, never a manufactured
// `fail`. The external fetcher is injected (real one wired in health-sweep).

const WINDOW = { start: new Date(Date.now() - 86_400_000), end: new Date(Date.now() + 86_400_000) };
let tId: string;
const ctx = (): EvidenceCtx => ({ tenantId: tId, db: adminPool, params: {}, window: WINDOW });

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "REC", publicKey: `rec-${Math.random()}`, clerkOrgId: `org_rec_${Math.random()}` }).returning();
  tId = t!.id;
  const [c] = await adminDb.insert(customer).values({ tenantId: tId, name: "AR Cust" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId: tId, customerId: c!.id, address: "1 AR St" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId: tId, customerId: c!.id, propertyId: p!.id }).returning();

  // Open AR = 100 (sent) + 50 (overdue) = 150. paid + draft + void excluded.
  const inv = await adminDb.insert(invoice).values([
    { tenantId: tId, jobId: j!.id, status: "sent", amountDue: 100 },
    { tenantId: tId, jobId: j!.id, status: "overdue", amountDue: 50 },
    { tenantId: tId, jobId: j!.id, status: "paid", amountDue: 9999 },
    { tenantId: tId, jobId: j!.id, status: "draft", amountDue: 9999 },
    { tenantId: tId, jobId: j!.id, status: "void", amountDue: 9999 },
  ]).returning();
  const invId = inv[0]!.id;

  // Stripe-recorded payments in window = 100 + 50 = 150. check (no stripe id) excluded.
  await adminDb.insert(payment).values([
    { tenantId: tId, invoiceId: invId, method: "card", amount: 100, stripePaymentId: "pi_1" },
    { tenantId: tId, invoiceId: invId, method: "card", amount: 50, stripePaymentId: "pi_2" },
    { tenantId: tId, invoiceId: invId, method: "check", amount: 9999, stripePaymentId: null },
  ]);
});

afterAll(async () => {
  await adminDb.delete(payment).where(eq(payment.tenantId, tId));
  await adminPool.end();
});

describe("finance.qb_reconcile", () => {
  it("passes when QuickBooks AR equals Savvy open AR", async () => {
    const res = await makeQbReconcileCheck(async () => 150)(ctx());
    expect(res.status).toBe("pass");
  });

  it("fails with the diff attached when AR diverges", async () => {
    const res = await makeQbReconcileCheck(async () => 200)(ctx());
    expect(res.status).toBe("fail");
    expect(res.details).toMatch(/150/);
    expect(res.details).toMatch(/200/);
    expect(res.refs.length).toBeGreaterThan(0);
  });

  it("skips when there is no QuickBooks connection (null)", async () => {
    const res = await makeQbReconcileCheck(async () => null)(ctx());
    expect(res.status).toBe("skip");
  });

  it("goes stale (not fail) on a vendor error", async () => {
    const res = await makeQbReconcileCheck(async () => { throw new Error("QBO 503"); })(ctx());
    expect(res.status).toBe("stale");
  });
});

describe("finance.stripe_match", () => {
  it("passes when Stripe collected equals the payments ledger", async () => {
    const res = await makeStripeMatchCheck(async () => 150)(ctx());
    expect(res.status).toBe("pass");
  });

  it("fails with the diff when they diverge", async () => {
    const res = await makeStripeMatchCheck(async () => 175)(ctx());
    expect(res.status).toBe("fail");
    expect(res.details).toMatch(/150/);
    expect(res.details).toMatch(/175/);
    expect(res.refs.length).toBeGreaterThan(0);
  });

  it("skips when there is no Stripe connection (null)", async () => {
    const res = await makeStripeMatchCheck(async () => null)(ctx());
    expect(res.status).toBe("skip");
  });

  it("goes stale on a vendor error", async () => {
    const res = await makeStripeMatchCheck(async () => { throw new Error("stripe down"); })(ctx());
    expect(res.status).toBe("stale");
  });
});
