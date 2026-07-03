import { describe, it, expect, vi } from "vitest";
import { adminDb, tenant, customer, property, job, withTenant, document, eq } from "@savvy/db";
import { makeFakeStorage } from "@savvy/integrations";
import { ingestSiteSnapPhoto } from "./sitesnap-ingest";

async function seed(key: string) {
  const [t] = await adminDb.insert(tenant).values({ name: "SS", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`, settings: { sitesnap: { ingestKey: key } } as never }).returning();
  const [c] = await adminDb.insert(customer).values({ tenantId: t!.id, name: "C" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId: t!.id, customerId: c!.id, address: "123 Main Street" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId: t!.id, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
  return { tenantId: t!.id, jobId: j!.id };
}

const fetchBytes = async () => ({ bytes: new Uint8Array([1, 2, 3]), mime: "image/jpeg" });

describe("ingestSiteSnapPhoto", () => {
  it("401s on an unknown key", async () => {
    const r = await ingestSiteSnapPhoto({ address: "x", category: "ridge", imageUrl: "u", externalPhotoId: "e1" }, "bad-key", { storage: makeFakeStorage(), fetchBytes, emit: vi.fn() });
    expect(r.status).toBe(401);
  });

  it("matches by address, stores to R2, records the doc, and emits", async () => {
    const key = `k-${crypto.randomUUID()}`;
    const { tenantId, jobId } = await seed(key);
    const storage = makeFakeStorage();
    const emit = vi.fn(async () => {});
    const r = await ingestSiteSnapPhoto({ address: "123 Main St.", category: "ridge", imageUrl: "u", externalPhotoId: "e2" }, key, { storage, fetchBytes, emit });
    expect(r.status).toBe(200);
    expect(storage.calls.some((c) => c.op === "put" || c.op === "upload")).toBe(true);
    const rows = await withTenant(tenantId, (tx) => tx.select().from(document).where(eq(document.sitesnapPhotoId, "e2")));
    expect(rows[0]!.jobId).toBe(jobId);
    expect(emit).toHaveBeenCalledWith(jobId, rows[0]!.id, tenantId);
  });

  it("stores unmatched (jobId null) when no address matches", async () => {
    const key = `k-${crypto.randomUUID()}`;
    const { tenantId } = await seed(key);
    const r = await ingestSiteSnapPhoto({ address: "999 Nowhere Rd", category: "eave", imageUrl: "u", externalPhotoId: "e3" }, key, { storage: makeFakeStorage(), fetchBytes, emit: vi.fn(async () => {}) });
    expect(r.status).toBe(200);
    const rows = await withTenant(tenantId, (tx) => tx.select().from(document).where(eq(document.sitesnapPhotoId, "e3")));
    expect(rows[0]!.jobId).toBeNull();
  });
});
