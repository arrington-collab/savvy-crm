import { describe, it, expect } from "vitest";
import { convertLeadToJob } from "../src/lifecycle/appointments.js";
import { adminDb, estimate, job, eq } from "../src/index.js";
import { makeTenant, makeLeadWithProperty } from "./helpers.js";

async function seedAcceptedEstimate(tenantId: string, leadId: string, propertyId: string): Promise<string> {
  const [e] = await adminDb
    .insert(estimate)
    .values({ tenantId, leadId, propertyId, source: "roofr", status: "accepted", total: 100_000 })
    .returning({ id: estimate.id });
  return e!.id;
}

/**
 * Slice 1 red-path: a job is created FROM an accepted estimate — not before.
 * convertLeadToJob is the single choke point, so it enforces the invariant.
 */
describe("convertLeadToJob — job-creation gate", () => {
  it("throws when the lead has no accepted estimate", async () => {
    const { tenantId } = await makeTenant();
    const { leadId } = await makeLeadWithProperty(tenantId);
    await expect(convertLeadToJob({ tenantId, leadId })).rejects.toThrow(/accepted estimate/i);
  });

  it("creates a job without an accepted estimate via the manualJob escape hatch", async () => {
    const { tenantId } = await makeTenant();
    const { leadId } = await makeLeadWithProperty(tenantId);
    const { jobId } = await convertLeadToJob({ tenantId, leadId, manualJob: true, reason: "out-of-funnel test job" });
    const [j] = await adminDb.select({ id: job.id }).from(job).where(eq(job.id, jobId));
    expect(j?.id).toBe(jobId);
  });

  it("carries the accepted estimate onto the new job (stamps job_id)", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId } = await makeLeadWithProperty(tenantId);
    const estimateId = await seedAcceptedEstimate(tenantId, leadId, propertyId);
    const { jobId } = await convertLeadToJob({ tenantId, leadId });
    const [e] = await adminDb.select({ jobId: estimate.jobId }).from(estimate).where(eq(estimate.id, estimateId));
    expect(e!.jobId).toBe(jobId);
  });
});
