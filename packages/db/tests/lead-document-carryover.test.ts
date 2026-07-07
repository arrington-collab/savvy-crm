import { describe, it, expect } from "vitest";
import { recordLeadDocument } from "../src/lifecycle/lead-documents.js";
import { convertLeadToJob } from "../src/lifecycle/appointments.js";
import { adminDb, document, eq } from "../src/index.js";
import { makeTenant, makeLeadWithProperty } from "./helpers.js";

describe("convertLeadToJob — lead document carryover", () => {
  it("stamps job_id onto the lead's documents at conversion", async () => {
    const { tenantId } = await makeTenant();
    const { leadId } = await makeLeadWithProperty(tenantId);

    const a = await recordLeadDocument({
      tenantId, leadId, uploadedByUserId: null,
      r2Key: `${tenantId}/lead/${leadId}/a.pdf`, kind: "insurance_estimate",
      filename: "a.pdf", mime: "application/pdf", sizeBytes: 10,
    });
    const b = await recordLeadDocument({
      tenantId, leadId, uploadedByUserId: null,
      r2Key: `${tenantId}/lead/${leadId}/b.pdf`, kind: "measurement_report",
      filename: "b.pdf", mime: "application/pdf", sizeBytes: 10,
    });

    // manualJob bypasses the accepted-estimate red-path; we only care about carryover here.
    const { jobId } = await convertLeadToJob({ tenantId, leadId, manualJob: true });

    const [da] = await adminDb.select().from(document).where(eq(document.id, a!.id));
    const [db] = await adminDb.select().from(document).where(eq(document.id, b!.id));
    expect(da!.jobId).toBe(jobId);
    expect(db!.jobId).toBe(jobId);
  });
});
