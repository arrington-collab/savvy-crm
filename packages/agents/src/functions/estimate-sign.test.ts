/**
 * Tests for the e-sign helper functions (createEstimateSubmission,
 * advanceJobForAcceptedEstimate). Uses a real Postgres DB (same approach as
 * the other agents tests). DocuSeal is injected via makeFakeDocuseal().
 *
 * Run with:
 *   DATABASE_URL=... DATABASE_ADMIN_URL=... pnpm test estimate-sign
 */
import { describe, it, expect } from "vitest";
import { adminDb, withTenant, eq, tenant, customer, property, job, lead, estimate, contractTemplate } from "@savvy/db";
import { makeFakeDocuseal } from "@savvy/integrations";
import { ContractTemplateRequiredError } from "@savvy/core";
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

// Cell 17b: block sending a CO estimate contract that isn't on a compliant SB38 template.
const CO_CLAUSES = ["right_to_rescind", "no_deductible_waiver", "ten_day"];

async function makeCoJobWithEstimate(tenantId: string, state = "CO"): Promise<{ estimateId: string }> {
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "CO Homeowner", email: "co@e2e.test" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: `1 ${state} Ave`, state }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "estimate" }).returning();
  const [e] = await adminDb.insert(estimate).values({ tenantId, jobId: j!.id, source: "roofr", status: "draft", lineItems: [], total: 900000 }).returning();
  return { estimateId: e!.id };
}

async function seedTemplate(tenantId: string, over: { state?: string; version?: number; clauses?: string[]; status?: string } = {}): Promise<string> {
  const [t] = await adminDb
    .insert(contractTemplate)
    .values({ tenantId, state: over.state ?? "CO", version: over.version ?? 1, name: "SB38", clauses: over.clauses ?? CO_CLAUSES, status: over.status ?? "active" })
    .returning();
  return t!.id;
}

describe("createEstimateSubmission — SB38 gate (cell 17b)", () => {
  it("throws ContractTemplateRequiredError for a CO estimate with no compliant template (and does not send)", async () => {
    const { tenantId } = await makeTenant();
    const { estimateId } = await makeCoJobWithEstimate(tenantId);
    await expect(createEstimateSubmission(tenantId, estimateId, makeFakeDocuseal())).rejects.toBeInstanceOf(
      ContractTemplateRequiredError,
    );
    // The estimate stays in draft — nothing was sent.
    const [after] = await withTenant(tenantId, (tx) => tx.select().from(estimate).where(eq(estimate.id, estimateId)));
    expect(after!.status).toBe("draft");
    expect(after!.docusealSubmissionId).toBeNull();
  });

  it("stamps the compliant template id and sends when a compliant CO template exists", async () => {
    const { tenantId } = await makeTenant();
    const templateId = await seedTemplate(tenantId, { version: 1 });
    await seedTemplate(tenantId, { version: 2, status: "draft" }); // a newer non-active one is ignored
    const { estimateId } = await makeCoJobWithEstimate(tenantId);
    const res = await createEstimateSubmission(tenantId, estimateId, makeFakeDocuseal());
    expect("submissionId" in res).toBe(true);
    const [after] = await withTenant(tenantId, (tx) => tx.select().from(estimate).where(eq(estimate.id, estimateId)));
    expect(after!.status).toBe("sent");
    expect(after!.contractTemplateId).toBe(templateId);
  });

  it("does not gate an AZ estimate (ungated jurisdiction) — no stamp, sends normally", async () => {
    const { tenantId } = await makeTenant();
    const { estimateId } = await makeCoJobWithEstimate(tenantId, "AZ");
    const res = await createEstimateSubmission(tenantId, estimateId, makeFakeDocuseal());
    expect("submissionId" in res).toBe(true);
    const [after] = await withTenant(tenantId, (tx) => tx.select().from(estimate).where(eq(estimate.id, estimateId)));
    expect(after!.status).toBe("sent");
    expect(after!.contractTemplateId).toBeNull();
  });
});

describe("advanceJobForAcceptedEstimate — lead-stage acceptance creates the job", () => {
  async function makeLeadWithEstimate(tenantId: string): Promise<{ leadId: string; estimateId: string }> {
    const [c] = await adminDb.insert(customer).values({ tenantId, name: "Lead Larry", email: "larry@e2e.test" }).returning();
    const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "3 Lead Ln" }).returning();
    const [l] = await adminDb.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, source: "test", lane: "standard" }).returning();
    const [e] = await adminDb
      .insert(estimate)
      .values({ tenantId, leadId: l!.id, propertyId: p!.id, source: "roofr", status: "sent", total: 500_000 })
      .returning();
    return { leadId: l!.id, estimateId: e!.id };
  }

  it("creates a job from a lead-stage estimate and carries the estimate onto it", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, estimateId } = await makeLeadWithEstimate(tenantId);

    const res = await advanceJobForAcceptedEstimate(tenantId, estimateId);
    expect("jobId" in res).toBe(true);
    const jobId = (res as { jobId: string }).jobId;

    const [j] = await adminDb.select({ leadId: job.leadId, stage: job.stage }).from(job).where(eq(job.id, jobId));
    expect(j!.leadId).toBe(leadId);
    expect(j!.stage).toBe("approved");

    const [after] = await adminDb.select({ jobId: estimate.jobId, status: estimate.status }).from(estimate).where(eq(estimate.id, estimateId));
    expect(after!.jobId).toBe(jobId); // estimate carried onto the new job
    expect(after!.status).toBe("accepted");
  });
});
