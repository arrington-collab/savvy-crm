import { afterAll, describe, it, expect } from "vitest";
import { inArray } from "drizzle-orm";
import { adminDb, adminPool } from "../admin-client.js";
import { pool } from "../client.js";
import { withTenant } from "../tenant.js";
import { tenant, user, customer, property, job, appointment, repAvailabilityBlock } from "../schema/index.js";
import { getRepBlocks } from "./availability.js";
import { repsAvailableAt } from "./availability.js";

const tenantIds: string[] = [];

async function seedTenantWithRep() {
  const [t] = await adminDb
    .insert(tenant)
    .values({ name: "AvailTest", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}` })
    .returning();
  tenantIds.push(t!.id);
  const [u] = await adminDb
    .insert(user)
    .values({ tenantId: t!.id, name: "Rep A", email: `rep-${crypto.randomUUID()}@x.com`, role: "rep" })
    .returning();
  return { tenantId: t!.id, userId: u!.id };
}

// mkTenant/mkRep helpers for repsAvailableAt tests
async function mkTenant(suffix: string): Promise<string> {
  const [t] = await adminDb
    .insert(tenant)
    .values({ name: `Tenant-${suffix}`, publicKey: `pk-${suffix}-${crypto.randomUUID()}`, clerkOrgId: `org-${suffix}-${crypto.randomUUID()}` })
    .returning();
  tenantIds.push(t!.id);
  return t!.id;
}

async function mkRep(tenantId: string, name: string): Promise<string> {
  const [u] = await adminDb
    .insert(user)
    .values({ tenantId, name, email: `${name.toLowerCase()}-${crypto.randomUUID()}@x.com`, role: "rep" })
    .returning();
  return u!.id;
}

/** Insert a minimal job + a scheduled appointment for a rep covering the given window. */
async function seedScheduledAppt(
  tenantId: string,
  userId: string,
  startIso: string,
  endIso: string,
): Promise<void> {
  await adminDb.transaction(async (tx) => {
    const [c] = await tx
      .insert(customer)
      .values({ tenantId, name: "Test Customer" })
      .returning();
    const [p] = await tx
      .insert(property)
      .values({ tenantId, customerId: c!.id, address: "1 Test St" })
      .returning();
    const [j] = await tx
      .insert(job)
      .values({ tenantId, customerId: c!.id, propertyId: p!.id })
      .returning();
    await tx.insert(appointment).values({
      tenantId,
      jobId: j!.id,
      type: "inspection",
      startsAt: new Date(startIso),
      endsAt: new Date(endIso),
      assigneeUserId: userId,
      status: "scheduled",
    });
  });
}

afterAll(async () => {
  if (tenantIds.length) {
    // Clean up in FK-safe order: appointments → jobs → customers → repAvailabilityBlock → users → tenants
    // Use adminDb so RLS doesn't interfere. Property is cascade-deleted with customer.
    await adminDb.delete(appointment).where(inArray(appointment.tenantId, tenantIds));
    await adminDb.delete(job).where(inArray(job.tenantId, tenantIds));
    await adminDb.delete(property).where(inArray(property.tenantId, tenantIds));
    await adminDb.delete(customer).where(inArray(customer.tenantId, tenantIds));
    await adminDb.delete(repAvailabilityBlock).where(inArray(repAvailabilityBlock.tenantId, tenantIds));
    await adminDb.delete(user).where(inArray(user.tenantId, tenantIds));
    await adminDb.delete(tenant).where(inArray(tenant.id, tenantIds));
  }
  await pool.end();
  await adminPool.end();
});

describe("getRepBlocks", () => {
  it("returns a rep's blocks overlapping the window", async () => {
    const { tenantId, userId } = await seedTenantWithRep();
    await withTenant(tenantId, async (tx) => {
      await tx.insert(repAvailabilityBlock).values({
        tenantId, userId,
        startsAt: new Date("2026-06-26T20:00:00Z"),
        endsAt: new Date("2026-06-26T22:00:00Z"),
        reason: "PTO",
      });
    });
    const blocks = await withTenant(tenantId, (tx) =>
      getRepBlocks(tx, { tenantId, userId, from: new Date("2026-06-26T00:00:00Z"), to: new Date("2026-06-27T00:00:00Z") }),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.startsAt.toISOString()).toBe("2026-06-26T20:00:00.000Z");
  });

  it("does not leak blocks across tenants (RLS)", async () => {
    const a = await seedTenantWithRep();
    await withTenant(a.tenantId, async (tx) => {
      await tx.insert(repAvailabilityBlock).values({
        tenantId: a.tenantId, userId: a.userId,
        startsAt: new Date("2026-06-26T20:00:00Z"), endsAt: new Date("2026-06-26T22:00:00Z"),
      });
    });
    const b = await seedTenantWithRep();
    const leaked = await withTenant(b.tenantId, (tx) =>
      getRepBlocks(tx, { tenantId: b.tenantId, userId: a.userId, from: new Date("2026-06-26T00:00:00Z"), to: new Date("2026-06-27T00:00:00Z") }),
    );
    expect(leaked).toHaveLength(0);
  });
});

describe("repsAvailableAt", () => {
  // Pick a window far in the future, inside default business hours, to avoid horizon/now edges.
  const at = new Date("2026-09-14T17:00:00Z"); // Mon 10:00 America/Phoenix

  it("excludes a rep with an overlapping scheduled appointment, keeps a free rep", async () => {
    const tid = await mkTenant("free-appt");
    const busyRep = await mkRep(tid, "Busy");
    const freeRep = await mkRep(tid, "Free");
    // a scheduled appt for busyRep covering `at` (needs a job for the FK)
    await seedScheduledAppt(tid, busyRep, "2026-09-14T16:30:00Z", "2026-09-14T17:30:00Z");
    const free = await repsAvailableAt(tid, { startsAt: at, type: "inspection" });
    expect(free).toContain(freeRep);
    expect(free).not.toContain(busyRep);
  });

  it("excludes a rep who blocked that time", async () => {
    const tid = await mkTenant("free-block");
    const rep = await mkRep(tid, "Blocker");
    await withTenant(tid, (tx) => tx.insert(repAvailabilityBlock).values({
      tenantId: tid, userId: rep, startsAt: new Date("2026-09-14T16:00:00Z"), endsAt: new Date("2026-09-14T18:00:00Z"),
    }));
    const free = await repsAvailableAt(tid, { startsAt: at, type: "inspection" });
    expect(free).not.toContain(rep);
  });

  it("does not see another tenant's reps (RLS)", async () => {
    const t1 = await mkTenant("free-iso1");
    const t2 = await mkTenant("free-iso2");
    const foreign = await mkRep(t2, "Foreign");
    const free = await repsAvailableAt(t1, { startsAt: at, type: "inspection" });
    expect(free).not.toContain(foreign);
  });
});
