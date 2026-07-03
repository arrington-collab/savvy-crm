import { describe, it, expect } from "vitest";
import { adminDb, tenant, customer, property, job, document } from "../index";

describe("document sitesnap columns", () => {
  it("accepts the new sitesnap/qc columns and defaults qcStatus to 'pending'", async () => {
    const [t] = await adminDb.insert(tenant).values({ name: "SS", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}` }).returning();
    const [c] = await adminDb.insert(customer).values({ tenantId: t!.id, name: "C" }).returning();
    const [p] = await adminDb.insert(property).values({ tenantId: t!.id, customerId: c!.id, address: "1 A St" }).returning();
    const [j] = await adminDb.insert(job).values({ tenantId: t!.id, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
    const [d] = await adminDb.insert(document).values({
      tenantId: t!.id, jobId: j!.id, kind: "photo", source: "sitesnap",
      label: "ridge", sitesnapPhotoId: "ss-1", captureAddress: "1 A St",
    }).returning();
    expect(d!.qcStatus).toBe("pending");
    expect(d!.sitesnapPhotoId).toBe("ss-1");
  });
});
