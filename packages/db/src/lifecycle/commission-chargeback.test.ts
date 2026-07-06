import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb, adminPool } from "../admin-client";
import { withTenant } from "../tenant";
import { tenant, user } from "../schema/tenancy";
import { customer, property } from "../schema/crm";
import { job } from "../schema/jobs";
import { invoice, commission } from "../schema/finance";
import { chargebackCommissionsForJob } from "./commission-chargeback";
import { recordStageChange } from "./record-stage-change";

// Cell 18: when a job is cancelled / called back (stage → 'lost'), any commission
// not yet paid out is charged back automatically. Paid commissions are flagged
// for manual clawback (money already left the building), never silently reversed.

let tId: string, repId: string;

async function makeJobWithCommissions(statuses: string[]): Promise<{ jobId: string; commissionIds: string[] }> {
  const [c] = await adminDb.insert(customer).values({ tenantId: tId, name: "CB Cust" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId: tId, customerId: c!.id, address: `cb-${Math.random()}` }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId: tId, customerId: c!.id, propertyId: p!.id, assignedUserId: repId, stage: "billing" }).returning();
  const commissionIds: string[] = [];
  // One invoice per commission — the commission table is unique per (tenant, invoice).
  for (const status of statuses) {
    const [inv] = await adminDb.insert(invoice).values({ tenantId: tId, jobId: j!.id, status: "paid", amountDue: 1000, amountPaid: 1000 }).returning();
    const [cm] = await adminDb
      .insert(commission)
      .values({ tenantId: tId, invoiceId: inv!.id, userId: repId, model: "flat", basisCents: 1000, rate: 1000, amountCents: 100, periodKey: "2026-07", status: status as "pending" })
      .returning();
    commissionIds.push(cm!.id);
  }
  return { jobId: j!.id, commissionIds };
}

const statusOf = async (id: string): Promise<string> =>
  (await adminDb.select({ s: commission.status }).from(commission).where(eq(commission.id, id)))[0]!.s;

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "CB", publicKey: `cb-${Math.random()}`, clerkOrgId: `org_cb_${Math.random()}` }).returning();
  tId = t!.id;
  const [u] = await adminDb.insert(user).values({ tenantId: tId, role: "rep", name: "Rep", email: `rep-${Math.random()}@x.test` }).returning();
  repId = u!.id;
});

afterAll(async () => {
  await adminPool.end();
});

describe("chargebackCommissionsForJob", () => {
  it("flips pending + approved commissions to charged_back and flags paid ones", async () => {
    const { jobId, commissionIds } = await makeJobWithCommissions(["pending", "approved", "paid"]);
    const res = await withTenant(tId, (tx) => chargebackCommissionsForJob(tx, { tenantId: tId, jobId }));
    expect(res.chargedBack).toBe(2);
    expect(res.paidNeedingClawback).toBe(1);
    expect(await statusOf(commissionIds[0]!)).toBe("charged_back");
    expect(await statusOf(commissionIds[1]!)).toBe("charged_back");
    expect(await statusOf(commissionIds[2]!)).toBe("paid"); // paid untouched
  });

  it("is a no-op for a job with no bookable commissions", async () => {
    const { jobId } = await makeJobWithCommissions(["paid"]);
    const res = await withTenant(tId, (tx) => chargebackCommissionsForJob(tx, { tenantId: tId, jobId }));
    expect(res.chargedBack).toBe(0);
    expect(res.paidNeedingClawback).toBe(1);
  });
});

describe("recordStageChange → 'lost' triggers chargeback", () => {
  it("charges back pending commissions when the job is marked lost", async () => {
    const { jobId, commissionIds } = await makeJobWithCommissions(["pending"]);
    await withTenant(tId, (tx) => recordStageChange(tx, { tenantId: tId, jobId, toStage: "lost", byAgent: "orchestrator" }));
    expect(await statusOf(commissionIds[0]!)).toBe("charged_back");
  });

  it("does NOT charge back on a non-lost transition", async () => {
    const { jobId, commissionIds } = await makeJobWithCommissions(["pending"]);
    await withTenant(tId, (tx) => recordStageChange(tx, { tenantId: tId, jobId, toStage: "production", byAgent: "orchestrator" }));
    expect(await statusOf(commissionIds[0]!)).toBe("pending");
  });
});
