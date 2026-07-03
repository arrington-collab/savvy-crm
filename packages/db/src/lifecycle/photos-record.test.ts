import { describe, it, expect } from "vitest";
import { adminDb, tenant, customer, property, job, document, withTenant, eq } from "../index";
import { recordSiteSnapPhoto, listUnmatchedPhotos, matchPhotoToJob } from "../index";

async function seed() {
  const [t] = await adminDb.insert(tenant).values({ name: "SS", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}` }).returning();
  const [c] = await adminDb.insert(customer).values({ tenantId: t!.id, name: "C" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId: t!.id, customerId: c!.id, address: "1 A St" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId: t!.id, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
  return { tenantId: t!.id, jobId: j!.id };
}

describe("recordSiteSnapPhoto", () => {
  it("inserts a photo document and is idempotent on sitesnapPhotoId", async () => {
    const { tenantId, jobId } = await seed();
    const a = await recordSiteSnapPhoto({ tenantId, jobId, category: "ridge", r2Key: "k1", captureAddress: "1 A St", sitesnapPhotoId: "ss-1" });
    expect(a.created).toBe(true);
    const b = await recordSiteSnapPhoto({ tenantId, jobId, category: "ridge", r2Key: "k1", captureAddress: "1 A St", sitesnapPhotoId: "ss-1" });
    expect(b.created).toBe(false);
    expect(b.documentId).toBe(a.documentId);
    const rows = await withTenant(tenantId, (tx) => tx.select().from(document).where(eq(document.sitesnapPhotoId, "ss-1")));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("photo");
    expect(rows[0]!.source).toBe("sitesnap");
    expect(rows[0]!.label).toBe("ridge");
  });

  it("lists unmatched photos and matchPhotoToJob attaches one to a job", async () => {
    const { tenantId, jobId } = await seed();
    const u = await recordSiteSnapPhoto({ tenantId, jobId: null, category: "eave", r2Key: "k2", captureAddress: "77 Lost Ln", sitesnapPhotoId: "ss-2" });
    const unmatched = await listUnmatchedPhotos(tenantId);
    expect(unmatched.map((x) => x.id)).toContain(u.documentId);
    await matchPhotoToJob({ tenantId, documentId: u.documentId, jobId });
    expect((await listUnmatchedPhotos(tenantId)).map((x) => x.id)).not.toContain(u.documentId);
  });
});
