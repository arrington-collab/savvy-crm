import { describe, it, expect } from "vitest";
import { adminDb, claim } from "../src/index.js";
import { makeTenant, makeLeadWithProperty } from "./helpers.js";

describe("claim_lead_open_uniq — at most one OPEN (job_id null) claim per lead", () => {
  it("rejects a second open lead-scoped claim for the same lead", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId } = await makeLeadWithProperty(tenantId);
    await adminDb.insert(claim).values({ tenantId, leadId, propertyId });
    await expect(
      adminDb.insert(claim).values({ tenantId, leadId, propertyId }),
    ).rejects.toThrow(); // partial unique on (lead_id) WHERE job_id is null
  });
});
