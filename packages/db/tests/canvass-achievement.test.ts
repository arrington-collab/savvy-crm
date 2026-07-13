import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { adminDb, adminPool, pool, eq, tenant, canvassRep, canvassAchievement } from "../src/index";
import { withTenant } from "../src/tenant";
import { unlockAchievements, listAchievementKeys } from "../src/lifecycle/canvass-achievement";

let tId: string, repId: string;

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "AchCo", publicKey: `ach-${Date.now()}`, clerkOrgId: `org_ach_${Date.now()}` }).returning();
  tId = t!.id;
  const [r] = await adminDb.insert(canvassRep).values({ tenantId: tId, name: "Rep", pinHash: "x" }).returning();
  repId = r!.id;
});
afterAll(async () => {
  await adminDb.delete(canvassAchievement).where(eq(canvassAchievement.tenantId, tId));
  await adminDb.delete(canvassRep).where(eq(canvassRep.tenantId, tId));
  await adminDb.delete(tenant).where(eq(tenant.id, tId));
  await pool.end();
  await adminPool.end();
});

describe("unlockAchievements", () => {
  it("inserts new keys and returns only the newly-unlocked ones", async () => {
    const first = await withTenant(tId, (tx) => unlockAchievements(tx, tId, repId, ["first_sale", "doors_100"]));
    expect(first.sort()).toEqual(["doors_100", "first_sale"]);
    const second = await withTenant(tId, (tx) => unlockAchievements(tx, tId, repId, ["first_sale", "hot_hand"]));
    expect(second).toEqual(["hot_hand"]); // first_sale already unlocked
    const keys = await withTenant(tId, (tx) => listAchievementKeys(tx, tId, repId));
    expect(keys.sort()).toEqual(["doors_100", "first_sale", "hot_hand"]);
  });
  it("returns [] for an empty key list", async () => {
    expect(await withTenant(tId, (tx) => unlockAchievements(tx, tId, repId, []))).toEqual([]);
  });
});
