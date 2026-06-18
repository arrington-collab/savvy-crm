import { afterAll, describe, it, expect } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { adminDb, adminPool } from "../admin-client.js";
import { pool } from "../client.js";
import { withTenant } from "../tenant.js";
import { crewCheckin, customer, property, job, user, tenant } from "../schema/index.js";
import { openCheckIn, closeCheckIn } from "./crew-checkin.js";

const tenantIds: string[] = [];
async function seed() {
  const [t] = await adminDb.insert(tenant).values({
    name: "Crew", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`,
  }).returning();
  tenantIds.push(t!.id);
  return withTenant(t!.id, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId: t!.id, name: "C" }).returning();
    const [p] = await tx.insert(property).values({ tenantId: t!.id, customerId: c!.id, address: "1 St" }).returning();
    const [j] = await tx.insert(job).values({ tenantId: t!.id, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
    const [u] = await tx.insert(user).values({ tenantId: t!.id, name: "Crew Cody", email: `cody-${crypto.randomUUID()}@x.com`, role: "crew" }).returning();
    return { tenantId: t!.id, jobId: j!.id, crewUserId: u!.id };
  });
}

afterAll(async () => {
  if (tenantIds.length) {
    await adminDb.delete(crewCheckin).where(inArray(crewCheckin.tenantId, tenantIds));
    await adminDb.delete(job).where(inArray(job.tenantId, tenantIds));
    await adminDb.delete(user).where(inArray(user.tenantId, tenantIds));
    await adminDb.delete(property).where(inArray(property.tenantId, tenantIds));
    await adminDb.delete(customer).where(inArray(customer.tenantId, tenantIds));
    await adminDb.delete(tenant).where(inArray(tenant.id, tenantIds));
  }
  await pool.end();
  await adminPool.end();
});

describe("crew check-in lifecycle", () => {
  it("opens once (idempotent) then closes", async () => {
    const { tenantId, jobId, crewUserId } = await seed();
    const a = await withTenant(tenantId, (tx) => openCheckIn(tx, { tenantId, jobId, crewUserId, lat: 33.4, lng: -112.0 }));
    expect(a.reused).toBe(false);
    const b = await withTenant(tenantId, (tx) => openCheckIn(tx, { tenantId, jobId, crewUserId }));
    expect(b.reused).toBe(true);
    expect(b.id).toBe(a.id);
    const closed = await withTenant(tenantId, (tx) => closeCheckIn(tx, { tenantId, jobId, crewUserId }));
    expect(closed?.id).toBe(a.id);
    const [row] = await withTenant(tenantId, (tx) => tx.select().from(crewCheckin).where(eq(crewCheckin.id, a.id)));
    expect(row!.checkedOutAt).not.toBeNull();
    expect(row!.checkInLat).toBe(33.4);
  });
  it("close with no open row is a no-op", async () => {
    const { tenantId, jobId, crewUserId } = await seed();
    const r = await withTenant(tenantId, (tx) => closeCheckIn(tx, { tenantId, jobId, crewUserId }));
    expect(r).toBeNull();
  });
});
