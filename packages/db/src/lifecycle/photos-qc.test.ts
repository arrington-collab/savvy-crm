import { describe, it, expect } from "vitest";
import { adminDb, tenant, customer, property, job, document, withTenant, eq } from "../index";
import { getPhotoForQc, getJobPhotoHashes, setPhotoQc, listFlaggedPhotos } from "./photos";

async function seed() {
  const [t] = await adminDb.insert(tenant).values({ name: "QC", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}` }).returning();
  const [c] = await adminDb.insert(customer).values({ tenantId: t!.id, name: "C" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId: t!.id, customerId: c!.id, address: "2 B St" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId: t!.id, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
  return { tenantId: t!.id, jobId: j!.id };
}

describe("getPhotoForQc", () => {
  it("returns the document fields for a matching photo", async () => {
    const { tenantId, jobId } = await seed();
    const [doc] = await adminDb.insert(document).values({
      tenantId, jobId, kind: "photo", label: "ridge", r2Key: "r2-abc", qcStatus: "pending",
    }).returning();
    const result = await getPhotoForQc({ tenantId, documentId: doc!.id });
    expect(result).not.toBeNull();
    expect(result!.jobId).toBe(jobId);
    expect(result!.r2Key).toBe("r2-abc");
    expect(result!.label).toBe("ridge");
    expect(result!.qcStatus).toBe("pending");
  });

  it("returns null for a missing documentId", async () => {
    const { tenantId } = await seed();
    const result = await getPhotoForQc({ tenantId, documentId: crypto.randomUUID() });
    expect(result).toBeNull();
  });
});

describe("getJobPhotoHashes", () => {
  it("returns other photos with phash on the job, excluding the given id", async () => {
    const { tenantId, jobId } = await seed();
    const [docA] = await adminDb.insert(document).values({
      tenantId, jobId, kind: "photo", label: "eave", r2Key: "r2-a", phash: "aaa111", qcStatus: "pending",
    }).returning();
    const [docB] = await adminDb.insert(document).values({
      tenantId, jobId, kind: "photo", label: "ridge", r2Key: "r2-b", phash: "bbb222", qcStatus: "pending",
    }).returning();
    // docC has no phash — must be excluded
    await adminDb.insert(document).values({
      tenantId, jobId, kind: "photo", label: "gutter", r2Key: "r2-c", qcStatus: "pending",
    });

    // Seed a second job under the SAME tenant and insert a photo with a phash.
    // The result must NOT include this doc — cross-job isolation check.
    const [c2] = await adminDb.insert(customer).values({ tenantId, name: "C2" }).returning();
    const [p2] = await adminDb.insert(property).values({ tenantId, customerId: c2!.id, address: "3 C St" }).returning();
    const [j2] = await adminDb.insert(job).values({ tenantId, customerId: c2!.id, propertyId: p2!.id, type: "retail", stage: "production" }).returning();
    const [docOtherJob] = await adminDb.insert(document).values({
      tenantId, jobId: j2!.id, kind: "photo", label: "fascia", r2Key: "r2-other", phash: "fff999", qcStatus: "pending",
    }).returning();

    const results = await getJobPhotoHashes({ tenantId, jobId, excludeDocumentId: docA!.id });
    const ids = results.map((r) => r.documentId);
    expect(ids).toContain(docB!.id);
    expect(ids).not.toContain(docA!.id);
    // Photo belonging to a different job must not appear even though it has a phash
    expect(ids).not.toContain(docOtherJob!.id);
    // All returned rows must have a non-null phash
    for (const r of results) expect(r.phash).toBeTruthy();
  });
});

describe("setPhotoQc", () => {
  it("writes phash/qcStatus/qcReasons; follow-up getPhotoForQc shows new qcStatus", async () => {
    const { tenantId, jobId } = await seed();
    const [doc] = await adminDb.insert(document).values({
      tenantId, jobId, kind: "photo", label: "soffit", r2Key: "r2-set", qcStatus: "pending",
    }).returning();
    await setPhotoQc({
      tenantId,
      documentId: doc!.id,
      phash: "deadbeef",
      qcStatus: "flagged",
      qcReasons: { quality: "blurry" },
    });
    const after = await getPhotoForQc({ tenantId, documentId: doc!.id });
    expect(after).not.toBeNull();
    expect(after!.qcStatus).toBe("flagged");
    // Verify phash was persisted
    const [row] = await withTenant(tenantId, (tx) =>
      tx.select({ phash: document.phash }).from(document).where(eq(document.id, doc!.id))
    );
    expect(row!.phash).toBe("deadbeef");
  });
});

describe("listFlaggedPhotos", () => {
  it("returns flagged photos with reason derived from qcReasons", async () => {
    const { tenantId, jobId } = await seed();
    const [flagged] = await adminDb.insert(document).values({
      tenantId, jobId, kind: "photo", label: "rake", r2Key: "r2-flag",
      qcStatus: "flagged", qcReasons: { quality: "blurry" },
    }).returning();
    // non-flagged — must be excluded
    await adminDb.insert(document).values({
      tenantId, jobId, kind: "photo", label: "hip", r2Key: "r2-ok", qcStatus: "ok",
    });
    // flagged but jobId null — must be excluded
    await adminDb.insert(document).values({
      tenantId, jobId: null, kind: "photo", label: "misc", r2Key: "r2-nojob",
      qcStatus: "flagged", qcReasons: { quality: "dark" },
    });
    const results = await listFlaggedPhotos(tenantId);
    const ids = results.map((r) => r.documentId);
    expect(ids).toContain(flagged!.id);
    const flaggedRow = results.find((r) => r.documentId === flagged!.id)!;
    expect(flaggedRow.reason).toContain("blurry");
    expect(flaggedRow.jobId).toBe(jobId);
    expect(flaggedRow.occurredAt).toBeInstanceOf(Date);
    // non-flagged label must not appear
    expect(results.map((r) => r.label)).not.toContain("hip");
  });
});
