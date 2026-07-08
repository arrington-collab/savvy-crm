import { beforeAll, afterAll, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createMaterialOrderFromEstimate, RescissionHoldError } from "../src/index.js";
import { adminDb, adminPool } from "../src/admin-client.js";
import { tenant, customer, property, job, estimate, materialOrder } from "../src/schema/index.js";

let tid: string, heldEst: string, freeEst: string, heldJob: string, freeJob: string;
const future = new Date(Date.now() + 3 * 86_400_000);
const past = new Date(Date.now() - 86_400_000);

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "MO", publicKey: `mo-${Date.now()}`, clerkOrgId: `org_mo_${Date.now()}` }).returning();
  tid = t!.id;
  const [c] = await adminDb.insert(customer).values({ tenantId: tid, name: "c" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId: tid, customerId: c!.id, address: `a-${crypto.randomUUID()}` }).returning();
  const [h] = await adminDb.insert(job).values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production", rescissionHoldUntil: future }).returning();
  const [f] = await adminDb.insert(job).values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production", rescissionHoldUntil: past }).returning();
  heldJob = h!.id; freeJob = f!.id;
  const [he] = await adminDb.insert(estimate).values({ tenantId: tid, jobId: heldJob, propertyId: p!.id, status: "accepted", lineItems: [] }).returning();
  const [fe] = await adminDb.insert(estimate).values({ tenantId: tid, jobId: freeJob, propertyId: p!.id, status: "accepted", lineItems: [] }).returning();
  heldEst = he!.id; freeEst = fe!.id;
});
afterAll(async () => {
  await adminDb.delete(materialOrder).where(eq(materialOrder.tenantId, tid));
  await adminDb.delete(estimate).where(eq(estimate.tenantId, tid));
  await adminDb.delete(job).where(eq(job.tenantId, tid));
  await adminDb.delete(property).where(eq(property.tenantId, tid));
  await adminDb.delete(customer).where(eq(customer.tenantId, tid));
  await adminDb.delete(tenant).where(eq(tenant.id, tid));
  await adminPool.end();
});

it("material order is BLOCKED while the job is held; no row inserted (RED PATH #3)", async () => {
  await expect(createMaterialOrderFromEstimate({ tenantId: tid, estimateId: heldEst })).rejects.toBeInstanceOf(RescissionHoldError);
  const rows = await adminDb.select().from(materialOrder).where(and(eq(materialOrder.tenantId, tid), eq(materialOrder.jobId, heldJob)));
  expect(rows).toHaveLength(0);
});
it("material order proceeds once the hold has elapsed", async () => {
  const r = await createMaterialOrderFromEstimate({ tenantId: tid, estimateId: freeEst });
  expect(r?.jobId).toBe(freeJob);
});
