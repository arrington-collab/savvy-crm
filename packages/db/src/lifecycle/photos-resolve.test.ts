import { describe, it, expect } from "vitest";
import { adminDb, tenant, customer, property, job } from "../index";
import { resolvePhotoJob, resolveTenantByIngestKey } from "../index";

async function seedTenant(settings: unknown = {}) {
  const [t] = await adminDb.insert(tenant).values({ name: "SS", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`, settings: settings as never }).returning();
  const [c] = await adminDb.insert(customer).values({ tenantId: t!.id, name: "C" }).returning();
  return { tenantId: t!.id, customerId: c!.id };
}

describe("resolvePhotoJob", () => {
  it("matches by normalized address and prefers the most recent open job", async () => {
    const { tenantId, customerId } = await seedTenant();
    const [p] = await adminDb.insert(property).values({ tenantId, customerId, address: "123 Main Street" }).returning();
    // an older completed job and a newer open job on the same property
    // (explicit createdAt so the desc-ordering is deterministic — no same-ms tie under the shared CI DB)
    await adminDb.insert(job).values({ tenantId, customerId, propertyId: p!.id, type: "retail", stage: "complete", createdAt: new Date(Date.now() - 60_000) }).returning();
    const [open] = await adminDb.insert(job).values({ tenantId, customerId, propertyId: p!.id, type: "retail", stage: "production", createdAt: new Date() }).returning();
    const r = await resolvePhotoJob({ tenantId, address: "123 Main St." }); // punctuation/suffix variant
    expect(r?.jobId).toBe(open!.id);
  });

  it("returns null when no property matches", async () => {
    const { tenantId } = await seedTenant();
    expect(await resolvePhotoJob({ tenantId, address: "999 Nowhere Rd" })).toBeNull();
  });
});

describe("resolveTenantByIngestKey", () => {
  it("resolves a tenant by its settings.sitesnap.ingestKey", async () => {
    const key = `k-${crypto.randomUUID()}`;
    const { tenantId } = await seedTenant({ sitesnap: { ingestKey: key } });
    expect((await resolveTenantByIngestKey(key))?.tenantId).toBe(tenantId);
    expect(await resolveTenantByIngestKey("nope")).toBeNull();
  });
});
