import { describe, it, expect } from "vitest";
import { adminDb, claim, upsertClaim, eq, and } from "../src/index.js";
import { makeTenant, makeLeadWithProperty, makeJobWithCustomer } from "./helpers.js";

describe("claim rescope (lead-scoped)", () => {
  it("stores a lead-scoped claim with a null job_id", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId } = await makeLeadWithProperty(tenantId);
    const [row] = await adminDb
      .insert(claim)
      .values({ tenantId, leadId, propertyId, carrierName: "State Farm", acvCents: 1000, lineItems: [{ description: "shingles", quantity: 1, amountCents: 500 }], parseConfidence: 0.9 })
      .returning();
    const [read] = await adminDb.select().from(claim).where(eq(claim.id, row!.id));
    expect(read!.jobId).toBeNull();
    expect(read!.leadId).toBe(leadId);
    expect(read!.propertyId).toBe(propertyId);
    expect(read!.carrierName).toBe("State Farm");
    expect(read!.parseConfidence).toBeCloseTo(0.9);
  });

  it("multiple lead-scoped claims (null job_id) coexist — partial unique only bites when job_id is set", async () => {
    const { tenantId } = await makeTenant();
    const a = await makeLeadWithProperty(tenantId);
    const b = await makeLeadWithProperty(tenantId);
    await adminDb.insert(claim).values({ tenantId, leadId: a.leadId, propertyId: a.propertyId });
    await expect(
      adminDb.insert(claim).values({ tenantId, leadId: b.leadId, propertyId: b.propertyId }),
    ).resolves.toBeDefined(); // two null-job_id claims do not collide
  });

  it("upsertClaim still upserts by job_id (job-stage path unchanged)", async () => {
    const { tenantId } = await makeTenant();
    const { jobId } = await makeJobWithCustomer(tenantId);
    await upsertClaim({ tenantId, jobId, carrierName: "Allstate" });
    await upsertClaim({ tenantId, jobId, claimNumber: "C-1" }); // update, not a 2nd row
    const rows = await adminDb.select().from(claim).where(and(eq(claim.tenantId, tenantId), eq(claim.jobId, jobId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.carrierName).toBe("Allstate");
    expect(rows[0]!.claimNumber).toBe("C-1");
  });
});
