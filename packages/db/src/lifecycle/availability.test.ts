import { afterAll, describe, it, expect } from "vitest";
import { inArray } from "drizzle-orm";
import { adminDb, adminPool } from "../admin-client.js";
import { pool } from "../client.js";
import { withTenant } from "../tenant.js";
import { tenant, user, repAvailabilityBlock } from "../schema/index.js";
import { getRepBlocks } from "./availability.js";

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

afterAll(async () => {
  if (tenantIds.length) {
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
