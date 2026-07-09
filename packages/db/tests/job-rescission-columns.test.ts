import { afterAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb, adminPool } from "../src/admin-client.js";
import { tenant, customer, property, job } from "../src/schema/index.js";

let tid: string;
afterAll(async () => {
  if (tid) {
    await adminDb.delete(job).where(eq(job.tenantId, tid));
    await adminDb.delete(property).where(eq(property.tenantId, tid));
    await adminDb.delete(customer).where(eq(customer.tenantId, tid));
    await adminDb.delete(tenant).where(eq(tenant.id, tid));
  }
  await adminPool.end();
});

it("job carries rescission_hold_until + canvass_rep_name", async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "RC", publicKey: `rc-${Date.now()}`, clerkOrgId: `org_rc_${Date.now()}` }).returning();
  tid = t!.id;
  const [c] = await adminDb.insert(customer).values({ tenantId: tid, name: "c" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId: tid, customerId: c!.id, address: `a-${crypto.randomUUID()}` }).returning();
  const hold = new Date("2026-07-07T07:00:00.000Z");
  const [j] = await adminDb.insert(job).values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "lead", rescissionHoldUntil: hold, canvassRepName: "Marcus R." }).returning();
  expect(j!.rescissionHoldUntil?.toISOString()).toBe(hold.toISOString());
  expect(j!.canvassRepName).toBe("Marcus R.");
});
