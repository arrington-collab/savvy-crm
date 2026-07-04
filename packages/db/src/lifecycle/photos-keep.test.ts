import { describe, it, expect } from "vitest";
import { adminDb, tenant, customer, property, job, document, user, auditLog, withTenant, eq, and } from "../index";
import { listFlaggedPhotosForJob, keepFlaggedPhoto } from "../index";

async function seed() {
  const [t] = await adminDb.insert(tenant).values({ name: "K", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}` }).returning();
  const [c] = await adminDb.insert(customer).values({ tenantId: t!.id, name: "C" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId: t!.id, customerId: c!.id, address: "1 A St" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId: t!.id, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
  const [u] = await adminDb.insert(user).values({ tenantId: t!.id, name: "U", email: `u-${crypto.randomUUID()}@x.com` }).returning();
  return { tenantId: t!.id, customerId: c!.id, propertyId: p!.id, jobId: j!.id, userId: u!.id };
}

async function addPhoto(tenantId: string, jobId: string | null, opts: { qcStatus: string; qcReasons?: unknown; label?: string }) {
  const [d] = await adminDb.insert(document).values({
    tenantId, jobId, kind: "photo", label: opts.label ?? "ridge", r2Key: `r2-${crypto.randomUUID()}`,
    qcStatus: opts.qcStatus, qcReasons: opts.qcReasons ?? null,
  }).returning({ id: document.id });
  return d!.id;
}

describe("listFlaggedPhotosForJob", () => {
  it("returns only this job's flagged photos with a derived reason; excludes passed + other-job", async () => {
    const { tenantId, jobId, customerId, propertyId } = await seed();
    const flaggedA = await addPhoto(tenantId, jobId, { qcStatus: "flagged", qcReasons: { quality: "blurry" }, label: "ridge" });
    await addPhoto(tenantId, jobId, { qcStatus: "passed" }); // excluded: passed
    // another job in the same tenant, also flagged → excluded
    const [j2] = await adminDb.insert(job).values({ tenantId, customerId, propertyId, type: "retail", stage: "production" }).returning();
    await addPhoto(tenantId, j2!.id, { qcStatus: "flagged", qcReasons: { quality: "dark" } });

    const rows = await listFlaggedPhotosForJob(tenantId, jobId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ documentId: flaggedA, label: "ridge", reason: "blurry" });
  });
});

describe("keepFlaggedPhoto", () => {
  it("flips flagged→passed, writes one photo_qc_kept audit row, returns jobId", async () => {
    const { tenantId, jobId, userId } = await seed();
    const docId = await addPhoto(tenantId, jobId, { qcStatus: "flagged", qcReasons: { quality: "blurry", wrongCategory: true } });

    const res = await keepFlaggedPhoto({ tenantId, userId, documentId: docId });
    expect(res).toEqual({ jobId });

    const [d] = await withTenant(tenantId, (tx) => tx.select({ qcStatus: document.qcStatus }).from(document).where(eq(document.id, docId)));
    expect(d!.qcStatus).toBe("passed");

    const audits = await withTenant(tenantId, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.entityId, docId), eq(auditLog.action, "photo_qc_kept"))));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.userId).toBe(userId);
    expect(audits[0]!.diff).toMatchObject({ from: "flagged", reasons: { quality: "blurry", wrongCategory: true } });
  });

  it("is a no-op returning null on an already-passed doc (no second audit row)", async () => {
    const { tenantId, jobId, userId } = await seed();
    const docId = await addPhoto(tenantId, jobId, { qcStatus: "flagged", qcReasons: { quality: "blurry" } });
    await keepFlaggedPhoto({ tenantId, userId, documentId: docId });         // first keep
    const again = await keepFlaggedPhoto({ tenantId, userId, documentId: docId }); // second
    expect(again).toBeNull();
    const audits = await withTenant(tenantId, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.entityId, docId), eq(auditLog.action, "photo_qc_kept"))));
    expect(audits).toHaveLength(1);
  });

  it("returns null for a missing document id", async () => {
    const { tenantId, userId } = await seed();
    expect(await keepFlaggedPhoto({ tenantId, userId, documentId: crypto.randomUUID() })).toBeNull();
  });

  it("accepts a null userId (unauthenticated/TEST_MODE) and still writes the audit row", async () => {
    const { tenantId, jobId } = await seed();
    const docId = await addPhoto(tenantId, jobId, { qcStatus: "flagged", qcReasons: { duplicateOf: "doc-9" } });
    const res = await keepFlaggedPhoto({ tenantId, userId: null, documentId: docId });
    expect(res).toEqual({ jobId });
    const audits = await withTenant(tenantId, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.entityId, docId), eq(auditLog.action, "photo_qc_kept"))));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.userId).toBeNull();
  });
});
