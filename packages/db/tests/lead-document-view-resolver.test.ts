import { beforeAll, afterAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDocumentForView } from "../src/index.js";
import { adminDb, adminPool } from "../src/admin-client.js";
import { tenant, customer, property, lead, document } from "../src/schema/index.js";

let tenantA: string, tenantB: string, docId: string;

beforeAll(async () => {
  const [a] = await adminDb.insert(tenant).values({ name: "VA", publicKey: `va-${Date.now()}`, clerkOrgId: `org_va_${Date.now()}` }).returning();
  const [b] = await adminDb.insert(tenant).values({ name: "VB", publicKey: `vb-${Date.now()}`, clerkOrgId: `org_vb_${Date.now()}` }).returning();
  tenantA = a!.id; tenantB = b!.id;
  const [c] = await adminDb.insert(customer).values({ tenantId: tenantA, name: "c" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId: tenantA, customerId: c!.id, address: `a-${crypto.randomUUID()}` }).returning();
  const [l] = await adminDb.insert(lead).values({ tenantId: tenantA, customerId: c!.id, propertyId: p!.id, source: "t", status: "new" }).returning();
  const [d] = await adminDb.insert(document).values({ tenantId: tenantA, leadId: l!.id, propertyId: p!.id, kind: "insurance_estimate", r2Key: "tenantA/lead/x/file.pdf", mime: "application/pdf", filename: "file.pdf" }).returning();
  docId = d!.id;
});

afterAll(async () => {
  for (const t of [tenantA, tenantB]) {
    await adminDb.delete(document).where(eq(document.tenantId, t));
    await adminDb.delete(lead).where(eq(lead.tenantId, t));
    await adminDb.delete(property).where(eq(property.tenantId, t));
    await adminDb.delete(customer).where(eq(customer.tenantId, t));
    await adminDb.delete(tenant).where(eq(tenant.id, t));
  }
  await adminPool.end();
});

it("resolves own-tenant doc", async () => {
  const r = await getDocumentForView(tenantA, docId);
  expect(r?.r2Key).toBe("tenantA/lead/x/file.pdf");
  expect(r?.mime).toBe("application/pdf");
});

it("returns null for a cross-tenant doc id (RLS) — RED PATH #1", async () => {
  const r = await getDocumentForView(tenantB, docId);
  expect(r).toBeNull();
});

it("returns null for an unknown id", async () => {
  const r = await getDocumentForView(tenantA, crypto.randomUUID());
  expect(r).toBeNull();
});
