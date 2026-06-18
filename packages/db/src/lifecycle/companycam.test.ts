import { afterAll, describe, it, expect } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { adminDb, adminPool } from "../admin-client.js";
import { pool } from "../client.js";
import { withTenant } from "../tenant.js";
import { document, customer, property, job, tenant } from "../schema/index.js";
import { recordCompanyCamPhoto } from "./companycam.js";

const tenantIds: string[] = [];
async function seedJob(projectId: string) {
  const [t] = await adminDb.insert(tenant).values({
    name: "CC", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`,
  }).returning();
  tenantIds.push(t!.id);
  return withTenant(t!.id, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId: t!.id, name: "C" }).returning();
    const [p] = await tx.insert(property).values({ tenantId: t!.id, customerId: c!.id, address: "1 St" }).returning();
    const [j] = await tx.insert(job).values({ tenantId: t!.id, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production", companycamProjectId: projectId }).returning();
    return { tenantId: t!.id, jobId: j!.id };
  });
}
afterAll(async () => {
  if (tenantIds.length) {
    await adminDb.delete(document).where(inArray(document.tenantId, tenantIds));
    await adminDb.delete(job).where(inArray(job.tenantId, tenantIds));
    await adminDb.delete(property).where(inArray(property.tenantId, tenantIds));
    await adminDb.delete(customer).where(inArray(customer.tenantId, tenantIds));
    await adminDb.delete(tenant).where(inArray(tenant.id, tenantIds));
  }
  await pool.end();
  await adminPool.end();
});

describe("recordCompanyCamPhoto", () => {
  it("inserts a companycam document and dedupes by photoId", async () => {
    const projectId = `proj-${crypto.randomUUID()}`;
    const { tenantId, jobId } = await seedJob(projectId);
    const photoId = "photo-1";
    const a = await recordCompanyCamPhoto({ projectId, photoId, url: "https://cc/p1.jpg" });
    expect(a?.created).toBe(true);
    expect(a?.jobId).toBe(jobId);
    const b = await recordCompanyCamPhoto({ projectId, photoId, url: "https://cc/p1.jpg" });
    expect(b?.created).toBe(false);
    const rows = await withTenant(tenantId, (tx) =>
      tx.select().from(document).where(and(eq(document.jobId, jobId), eq(document.source, "companycam"))));
    expect(rows.length).toBe(1);
    expect(rows[0]!.externalUrl).toBe("https://cc/p1.jpg");
    expect(rows[0]!.r2Key).toBeNull();
  });
  it("returns null for an unknown project", async () => {
    const r = await recordCompanyCamPhoto({ projectId: "nope", photoId: "x", url: "u" });
    expect(r).toBeNull();
  });
});
