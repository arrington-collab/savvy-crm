import { describe, it, expect } from "vitest";
import { attachOrCreateLeadClaim } from "../src/lifecycle/claim.js";
import { convertLeadToJob } from "../src/lifecycle/appointments.js";
import { adminDb, claim, eq } from "../src/index.js";
import { makeTenant, makeLeadWithProperty } from "./helpers.js";

describe("convertLeadToJob — claim carryover", () => {
  it("stamps job_id onto the lead's claim at conversion", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId } = await makeLeadWithProperty(tenantId);
    const c = await attachOrCreateLeadClaim({
      tenantId, leadId, propertyId, carrierName: "State Farm", claimNumber: "C-1",
      acvCents: 1000, rcvCents: 2000, deductibleCents: 500, lineItems: [], parseConfidence: 0.9,
    });

    const { jobId } = await convertLeadToJob({ tenantId, leadId, manualJob: true });

    const [row] = await adminDb.select().from(claim).where(eq(claim.id, c.claimId));
    expect(row!.jobId).toBe(jobId);
  });
});
