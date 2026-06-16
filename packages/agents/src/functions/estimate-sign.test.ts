/**
 * Tests for the e-sign helper functions (createEstimateSubmission,
 * advanceJobForAcceptedEstimate). Uses a real Postgres DB (same approach as
 * the other agents tests). DocuSeal is injected via makeFakeDocuseal().
 *
 * Run with:
 *   DATABASE_URL=... DATABASE_ADMIN_URL=... pnpm test estimate-sign
 */
import { describe, it, expect } from "vitest";
import { adminDb, withTenant, eq, tenant, customer, property, job, estimate } from "@savvy/db";
import { makeFakeDocuseal } from "@savvy/integrations";
import { createEstimateSubmission, advanceJobForAcceptedEstimate } from "./estimate-sign";

async function makeTenant(): Promise<{ tenantId: string }> {
  const [t] = await adminDb
    .insert(tenant)
    .values({ name: "SignTest", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}` })
    .returning();
  return { tenantId: t!.id };
}

async function makeJobWithEstimate(tenantId: string): Promise<{ jobId: string; estimateId: string }> {
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "Signer Sam", email: "sam@e2e.test" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "9 Sign St" }).returning();
  const [j] = await adminDb
    .insert(job)
    .values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "estimate" })
    .returning();
  const [e] = await adminDb
    .insert(estimate)
    .values({ tenantId, jobId: j!.id, source: "roofr", status: "draft", lineItems: [], total: 500000 })
    .returning();
  return { jobId: j!.id, estimateId: e!.id };
}

describe("createEstimateSubmission", () => {
  it("creates a submission via the gateway and flips the estimate to sent", async () => {
    const { tenantId } = await makeTenant();
    const { estimateId } = await makeJobWithEstimate(tenantId);
    const res = await createEstimateSubmission(tenantId, estimateId, makeFakeDocuseal());
    expect("submissionId" in res && res.submissionId).toMatch(/^ds_sub_/);
    const [after] = await withTenant(tenantId, (tx) => tx.select().from(estimate).where(eq(estimate.id, estimateId)));
    expect(after!.status).toBe("sent");
    expect(after!.docusealSubmissionId).toMatch(/^ds_sub_/);
    expect(after!.sentAt).not.toBeNull();
  });

  it("skips an already-accepted estimate", async () => {
    const { tenantId } = await makeTenant();
    const { estimateId } = await makeJobWithEstimate(tenantId);
    await adminDb.update(estimate).set({ status: "accepted" }).where(eq(estimate.id, estimateId));
    const res = await createEstimateSubmission(tenantId, estimateId, makeFakeDocuseal());
    expect(res).toEqual({ skipped: true });
  });
});

describe("advanceJobForAcceptedEstimate", () => {
  it("marks the estimate accepted and advances the job to approved", async () => {
    const { tenantId } = await makeTenant();
    const { jobId, estimateId } = await makeJobWithEstimate(tenantId);
    const res = await advanceJobForAcceptedEstimate(tenantId, estimateId);
    expect(res).toEqual({ jobId });
    const [e] = await withTenant(tenantId, (tx) => tx.select().from(estimate).where(eq(estimate.id, estimateId)));
    expect(e!.status).toBe("accepted");
    expect(e!.acceptedAt).not.toBeNull();
    const [j] = await withTenant(tenantId, (tx) => tx.select().from(job).where(eq(job.id, jobId)));
    expect(j!.stage).toBe("approved");
    expect(j!.valueEstimate).toBe(500000);
  });
});
