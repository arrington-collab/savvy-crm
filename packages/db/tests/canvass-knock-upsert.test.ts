import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { adminDb, adminPool, pool, eq, tenant, canvassRep, canvassTerritory, canvassKnock, canvassAchievement } from "../src/index";
import { withTenant } from "../src/tenant";
import { upsertCanvassKnock, isCanvassManager, isCanvassRepActive } from "../src/lifecycle/canvass-knock";
import { evaluateAchievements } from "@savvy/core";
import { unlockAchievements } from "../src/lifecycle/canvass-achievement";

let tId: string, repA: string, repB: string, mgrId: string, terrId: string;

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "KU Co", publicKey: `ku-${Date.now()}`, clerkOrgId: `org_ku_${Date.now()}` }).returning();
  tId = t!.id;
  const reps = await adminDb
    .insert(canvassRep)
    .values([
      { tenantId: tId, name: "Rep A", pinHash: "x" },
      { tenantId: tId, name: "Rep B", pinHash: "x" },
      { tenantId: tId, name: "Mgr", pinHash: "x", manager: true },
    ])
    .returning();
  repA = reps[0]!.id;
  repB = reps[1]!.id;
  mgrId = reps[2]!.id;
  const [terr] = await adminDb
    .insert(canvassTerritory)
    .values({ tenantId: tId, clientId: "terr-local-1", name: "North Mesa", points: [[33.4, -111.8], [33.5, -111.8], [33.5, -111.9]] })
    .returning();
  terrId = terr!.id;
});

afterAll(async () => {
  await adminDb.delete(canvassKnock).where(eq(canvassKnock.tenantId, tId));
  await adminDb.delete(canvassAchievement).where(eq(canvassAchievement.tenantId, tId));
  await adminDb.delete(canvassTerritory).where(eq(canvassTerritory.tenantId, tId));
  await adminDb.delete(canvassRep).where(eq(canvassRep.tenantId, tId));
  await adminDb.delete(tenant).where(eq(tenant.id, tId));
  await pool.end();
  await adminPool.end();
});

const base = (repId: string) => ({
  tenantId: tId,
  repId,
  clientId: "knock-1",
  lat: 33.42,
  lng: -111.84,
  outcome: "callback",
  gpsFlagged: false,
});

describe("upsertCanvassKnock", () => {
  it("inserts, resolves the territory clientId, and returns the id", async () => {
    const { id } = await withTenant(tId, (tx) => upsertCanvassKnock(tx, { ...base(repA), territoryClientId: "terr-local-1" }));
    expect(id).toBeTruthy();
    const [row] = await adminDb.select().from(canvassKnock).where(eq(canvassKnock.tenantId, tId));
    expect(row!.territoryId).toBe(terrId);
    expect(row!.outcome).toBe("callback");
  });

  it("updates the mutable fields on replay with the same clientId (appt→sale after signing)", async () => {
    const { id } = await withTenant(tId, (tx) =>
      upsertCanvassKnock(tx, { ...base(repA), outcome: "sale", amount: 12500, contactName: "Jane HO" }),
    );
    expect(id).toBeTruthy();
    const rows = await adminDb.select().from(canvassKnock).where(eq(canvassKnock.tenantId, tId));
    expect(rows).toHaveLength(1); // upsert, not a duplicate
    expect(rows[0]!.outcome).toBe("sale");
    expect(rows[0]!.amount).toBe(12500);
    expect(rows[0]!.contactName).toBe("Jane HO");
  });

  it("refuses a different rep's edit of the same clientId (no knock stealing)", async () => {
    const { id } = await withTenant(tId, (tx) => upsertCanvassKnock(tx, { ...base(repB), outcome: "notint" }));
    expect(id).toBeNull(); // conflict hit, setWhere blocked the update
    const [row] = await adminDb.select().from(canvassKnock).where(eq(canvassKnock.tenantId, tId));
    expect(row!.repId).toBe(repA);
    expect(row!.outcome).toBe("sale"); // untouched
  });

  it("leaves territory unassigned for an unknown territoryClientId", async () => {
    const { id } = await withTenant(tId, (tx) =>
      upsertCanvassKnock(tx, { ...base(repA), clientId: "knock-2", territoryClientId: "nope" }),
    );
    expect(id).toBeTruthy();
    const [row] = await adminDb.select().from(canvassKnock).where(eq(canvassKnock.clientId, "knock-2"));
    expect(row!.territoryId).toBeNull();
  });

  it("stamps contract_signed_at + lead_id on a same-rep re-upsert (contract signed)", async () => {
    const leadUuid = "11111111-1111-1111-1111-111111111111";
    const signedAt = new Date("2026-07-12T18:30:00.000Z");
    // base(repA) uses clientId "knock-1", already owned by repA from earlier tests
    const { id } = await withTenant(tId, (tx) =>
      upsertCanvassKnock(tx, { ...base(repA), outcome: "sale", amount: 9000, contractSignedAt: signedAt, leadId: leadUuid }),
    );
    expect(id).toBeTruthy();
    const [row] = await adminDb.select().from(canvassKnock).where(eq(canvassKnock.clientId, "knock-1"));
    expect(row!.leadId).toBe(leadUuid);
    expect(row!.contractSignedAt?.toISOString()).toBe(signedAt.toISOString());
  });
});

describe("isCanvassRepActive", () => {
  it("is true for an active rep, false once deactivated or unknown", async () => {
    await withTenant(tId, async (tx) => {
      expect(await isCanvassRepActive(tx, tId, repB)).toBe(true);
      expect(await isCanvassRepActive(tx, tId, "00000000-0000-0000-0000-000000000000")).toBe(false);
    });
    await adminDb.update(canvassRep).set({ active: false }).where(eq(canvassRep.id, repB));
    await withTenant(tId, async (tx) => {
      expect(await isCanvassRepActive(tx, tId, repB)).toBe(false);
    });
    await adminDb.update(canvassRep).set({ active: true }).where(eq(canvassRep.id, repB));
  });
});

describe("isCanvassManager", () => {
  it("is true only for an active manager rep", async () => {
    await withTenant(tId, async (tx) => {
      expect(await isCanvassManager(tx, tId, mgrId)).toBe(true);
      expect(await isCanvassManager(tx, tId, repA)).toBe(false);
      expect(await isCanvassManager(tx, tId, "00000000-0000-0000-0000-000000000000")).toBe(false);
    });
    await adminDb.update(canvassRep).set({ active: false }).where(eq(canvassRep.id, mgrId));
    await withTenant(tId, async (tx) => {
      expect(await isCanvassManager(tx, tId, mgrId)).toBe(false);
    });
  });
});

describe("achievements on knock", () => {
  it("first_sale unlocks once a sale exists", async () => {
    await withTenant(tId, (tx) => upsertCanvassKnock(tx, { ...base(repA), clientId: "ach-1", outcome: "sale", amount: 1000 }));
    const earned = await withTenant(tId, async (tx) => {
      const earnedKeys = evaluateAchievements({ knocks: [{ outcome: "sale", amount: 1000, at: new Date() }], tz: "America/Phoenix" });
      return unlockAchievements(tx, tId, repA, earnedKeys);
    });
    expect(earned).toContain("first_sale");
  });
});
