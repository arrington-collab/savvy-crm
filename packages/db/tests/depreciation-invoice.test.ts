import { describe, it, expect } from "vitest";
import { withTenant } from "../src/tenant.js";
import { adminDb } from "../src/admin-client.js";
import { detectDepreciationRecovery, DEPRECIATION_TASK_KEY } from "../src/lifecycle/depreciation-recovery.js";
import { draftDepreciationInvoice, sendDepreciationInvoice, DEPRECIATION_APPROVAL_TASK_KEY } from "../src/lifecycle/depreciation-recovery.js";
import { job, claim, invoice, jobChecklistItem } from "../src/schema/index.js";
import { eq, and } from "drizzle-orm";
import { makeTenant, makeJobWithCustomer } from "./helpers.js";

async function seedInsuranceJob(opts: { rcvCents: number | null; acvCents: number | null }) {
  const { tenantId } = await makeTenant();
  const { jobId } = await makeJobWithCustomer(tenantId);
  await adminDb.update(job).set({ type: "insurance", stage: "complete" }).where(eq(job.id, jobId));
  await withTenant(tenantId, (tx) => tx.insert(claim).values({ tenantId, jobId, rcvCents: opts.rcvCents, acvCents: opts.acvCents, status: "approved" }));
  return { tenantId, jobId };
}

async function taskByKey(tenantId: string, jobId: string, key: string) {
  const [row] = await withTenant(tenantId, (tx) => tx.select().from(jobChecklistItem).where(and(eq(jobChecklistItem.jobId, jobId), eq(jobChecklistItem.key, key))));
  return row;
}

describe("draftDepreciationInvoice", () => {
  it("drafts the recovery invoice, marks the detection task done, and queues a send-approval task", async () => {
    const { tenantId, jobId } = await seedInsuranceJob({ rcvCents: 2_000_000, acvCents: 1_400_000 });
    await detectDepreciationRecovery({ tenantId, jobId }); // the G1 office task

    const r = await draftDepreciationInvoice({ tenantId, jobId });
    expect(r).toMatchObject({ amountCents: 600_000 });
    const invoiceId = (r as { invoiceId: string }).invoiceId;

    const [inv] = await adminDb.select().from(invoice).where(eq(invoice.id, invoiceId));
    expect(inv!.status).toBe("draft"); // nothing goes to the carrier without approval
    expect(inv!.amountDue).toBe(600_000);

    const detection = await taskByKey(tenantId, jobId, DEPRECIATION_TASK_KEY);
    expect(detection!.status).toBe("done");

    const approval = await taskByKey(tenantId, jobId, DEPRECIATION_APPROVAL_TASK_KEY);
    expect(approval!.status).toBe("pending");
    expect(approval!.dueAt).not.toBeNull(); // surfaces in Needs-you
    expect((approval!.payload as { invoiceId?: string }).invoiceId).toBe(invoiceId);
  });

  it("uses the updated Xactimate RCV when provided (and re-prices the claim)", async () => {
    const { tenantId, jobId } = await seedInsuranceJob({ rcvCents: 2_000_000, acvCents: 1_400_000 });
    const r = await draftDepreciationInvoice({ tenantId, jobId, updatedRcvCents: 2_200_000 });
    expect(r).toMatchObject({ amountCents: 800_000 });
    const [c] = await adminDb.select({ rcvCents: claim.rcvCents }).from(claim).where(eq(claim.jobId, jobId));
    expect(c!.rcvCents).toBe(2_200_000);
  });

  it("is idempotent — a second draft is skipped", async () => {
    const { tenantId, jobId } = await seedInsuranceJob({ rcvCents: 2_000_000, acvCents: 1_400_000 });
    await draftDepreciationInvoice({ tenantId, jobId });
    const again = await draftDepreciationInvoice({ tenantId, jobId });
    expect(again).toEqual({ skipped: "already_drafted" });
  });

  it("skips a retail job", async () => {
    const { tenantId } = await makeTenant();
    const { jobId } = await makeJobWithCustomer(tenantId);
    const r = await draftDepreciationInvoice({ tenantId, jobId });
    expect(r).toEqual({ skipped: "not_insurance" });
  });
});

describe("sendDepreciationInvoice", () => {
  it("marks the draft invoice sent and closes the approval task", async () => {
    const { tenantId, jobId } = await seedInsuranceJob({ rcvCents: 2_000_000, acvCents: 1_400_000 });
    const d = await draftDepreciationInvoice({ tenantId, jobId });
    const invoiceId = (d as { invoiceId: string }).invoiceId;

    const r = await sendDepreciationInvoice({ tenantId, jobId, invoiceId });
    expect(r).toMatchObject({ sent: true, jobId });

    const [inv] = await adminDb.select({ status: invoice.status }).from(invoice).where(eq(invoice.id, invoiceId));
    expect(inv!.status).toBe("sent");
    const approval = await taskByKey(tenantId, jobId, DEPRECIATION_APPROVAL_TASK_KEY);
    expect(approval!.status).toBe("done");
  });

  it("skips when the invoice is not a draft (already sent)", async () => {
    const { tenantId, jobId } = await seedInsuranceJob({ rcvCents: 2_000_000, acvCents: 1_400_000 });
    const d = await draftDepreciationInvoice({ tenantId, jobId });
    const invoiceId = (d as { invoiceId: string }).invoiceId;
    await sendDepreciationInvoice({ tenantId, jobId, invoiceId });
    const again = await sendDepreciationInvoice({ tenantId, jobId, invoiceId });
    expect(again).toEqual({ skipped: "not_draft" });
  });
});
