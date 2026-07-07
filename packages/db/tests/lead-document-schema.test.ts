import { describe, it, expect } from "vitest";
import { adminDb, document, eq } from "../src/index.js";
import { makeTenant, makeLeadWithProperty, makeUser } from "./helpers.js";

describe("document lead-scope columns", () => {
  it("stores a lead-scoped document with uploader and defaults parse_status to pending", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId } = await makeLeadWithProperty(tenantId);
    const { userId } = await makeUser(tenantId);

    const [row] = await adminDb
      .insert(document)
      .values({
        tenantId,
        leadId,
        propertyId,
        uploadedByUserId: userId,
        kind: "insurance_estimate",
        r2Key: `${tenantId}/lead/${leadId}/x.pdf`,
        filename: "estimate.pdf",
        mime: "application/pdf",
        sizeBytes: 1234,
        source: "savvy",
      })
      .returning();

    const [read] = await adminDb.select().from(document).where(eq(document.id, row!.id));
    expect(read!.leadId).toBe(leadId);
    expect(read!.propertyId).toBe(propertyId);
    expect(read!.uploadedByUserId).toBe(userId);
    expect(read!.parseStatus).toBe("pending");
    expect(read!.parseConfidence).toBeNull();
  });
});
