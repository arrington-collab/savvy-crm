import { afterAll, describe, it, expect } from "vitest";
import { inArray } from "drizzle-orm";
import { adminDb, adminPool } from "../admin-client.js";
import { pool } from "../client.js";
import { withTenant } from "../tenant.js";
import { tenant, user, crew, crewMember } from "../schema/index.js";
import {
  createCrew,
  listCrews,
  renameCrew,
  setCrewActive,
  setCrewLocation,
  addCrewMember,
  removeCrewMember,
  listCrewIdsForUser,
} from "./crew.js";

const tenantIds: string[] = [];

async function seedTenant() {
  const [t] = await adminDb
    .insert(tenant)
    .values({ name: "CrewTest", publicKey: `pk-crew-${crypto.randomUUID()}`, clerkOrgId: `org-crew-${crypto.randomUUID()}` })
    .returning();
  tenantIds.push(t!.id);
  return t!.id;
}

async function seedUser(tenantId: string, name: string) {
  const [u] = await adminDb
    .insert(user)
    .values({ tenantId, name, email: `${name.toLowerCase().replace(/\s/g, "-")}-${crypto.randomUUID()}@x.com`, role: "crew" })
    .returning();
  return u!.id;
}

afterAll(async () => {
  if (tenantIds.length) {
    await adminDb.delete(crewMember).where(inArray(crewMember.tenantId, tenantIds));
    await adminDb.delete(crew).where(inArray(crew.tenantId, tenantIds));
    await adminDb.delete(user).where(inArray(user.tenantId, tenantIds));
    await adminDb.delete(tenant).where(inArray(tenant.id, tenantIds));
  }
  await pool.end();
  await adminPool.end();
});

describe("createCrew", () => {
  it("creates a crew row", async () => {
    const tenantId = await seedTenant();
    const row = await createCrew({ tenantId, name: "Alpha Crew" });
    expect(row.name).toBe("Alpha Crew");
    expect(row.active).toBe(true);
    expect(row.tenantId).toBe(tenantId);
    expect(typeof row.id).toBe("string");
  });
});

describe("listCrews", () => {
  it("returns crews with members", async () => {
    const tenantId = await seedTenant();
    const crewRow = await createCrew({ tenantId, name: "Beta Crew" });
    const u1 = await seedUser(tenantId, "Worker One");
    const u2 = await seedUser(tenantId, "Worker Two");
    await addCrewMember({ tenantId, crewId: crewRow.id, userId: u1 });
    await addCrewMember({ tenantId, crewId: crewRow.id, userId: u2 });

    const crews = await listCrews(tenantId);
    const found = crews.find((c) => c.id === crewRow.id);
    expect(found).toBeDefined();
    expect(found!.name).toBe("Beta Crew");
    expect(found!.members).toHaveLength(2);
    const memberUserIds = found!.members.map((m) => m.userId);
    expect(memberUserIds).toContain(u1);
    expect(memberUserIds).toContain(u2);
  });
});

describe("renameCrew", () => {
  it("renames a crew", async () => {
    const tenantId = await seedTenant();
    const crewRow = await createCrew({ tenantId, name: "Old Name" });
    await renameCrew({ tenantId, crewId: crewRow.id, name: "New Name" });
    const crews = await listCrews(tenantId);
    const found = crews.find((c) => c.id === crewRow.id);
    expect(found!.name).toBe("New Name");
  });
});

describe("setCrewActive", () => {
  it("toggles active flag", async () => {
    const tenantId = await seedTenant();
    const crewRow = await createCrew({ tenantId, name: "Toggle Crew" });
    expect(crewRow.active).toBe(true);

    await setCrewActive({ tenantId, crewId: crewRow.id, active: false });
    const crews = await listCrews(tenantId);
    const found = crews.find((c) => c.id === crewRow.id);
    expect(found!.active).toBe(false);

    await setCrewActive({ tenantId, crewId: crewRow.id, active: true });
    const crews2 = await listCrews(tenantId);
    expect(crews2.find((c) => c.id === crewRow.id)!.active).toBe(true);
  });
});

describe("setCrewLocation", () => {
  it("sets and clears the crew's home-base lat/lng (surfaced by listCrews)", async () => {
    const tenantId = await seedTenant();
    const crewRow = await createCrew({ tenantId, name: "Yard Crew" });
    const created = (await listCrews(tenantId)).find((c) => c.id === crewRow.id)!;
    expect(created.baseLat).toBeNull();
    expect(created.baseLng).toBeNull();

    await setCrewLocation({ tenantId, crewId: crewRow.id, baseLat: 33.45, baseLng: -112.07 });
    const set = (await listCrews(tenantId)).find((c) => c.id === crewRow.id)!;
    expect(set.baseLat).toBe(33.45);
    expect(set.baseLng).toBe(-112.07);

    await setCrewLocation({ tenantId, crewId: crewRow.id, baseLat: null, baseLng: null });
    const cleared = (await listCrews(tenantId)).find((c) => c.id === crewRow.id)!;
    expect(cleared.baseLat).toBeNull();
    expect(cleared.baseLng).toBeNull();
  });
});

describe("addCrewMember", () => {
  it("is idempotent: adding same userId twice results in only one row", async () => {
    const tenantId = await seedTenant();
    const crewRow = await createCrew({ tenantId, name: "Idempotent Crew" });
    const userId = await seedUser(tenantId, "Dup User");

    await addCrewMember({ tenantId, crewId: crewRow.id, userId });
    await addCrewMember({ tenantId, crewId: crewRow.id, userId }); // duplicate, should be no-op

    const crews = await listCrews(tenantId);
    const found = crews.find((c) => c.id === crewRow.id);
    expect(found!.members.filter((m) => m.userId === userId)).toHaveLength(1);
  });
});

describe("removeCrewMember", () => {
  it("removes a member from a crew", async () => {
    const tenantId = await seedTenant();
    const crewRow = await createCrew({ tenantId, name: "Remove Crew" });
    const userId = await seedUser(tenantId, "Gone User");

    await addCrewMember({ tenantId, crewId: crewRow.id, userId });
    const before = await listCrews(tenantId);
    expect(before.find((c) => c.id === crewRow.id)!.members.map((m) => m.userId)).toContain(userId);

    await removeCrewMember({ tenantId, crewId: crewRow.id, userId });
    const after = await listCrews(tenantId);
    expect(after.find((c) => c.id === crewRow.id)!.members.map((m) => m.userId)).not.toContain(userId);
  });
});

describe("listCrewIdsForUser", () => {
  it("returns the correct crew ids for a user", async () => {
    const tenantId = await seedTenant();
    const crew1 = await createCrew({ tenantId, name: "Crew X" });
    const crew2 = await createCrew({ tenantId, name: "Crew Y" });
    const userId = await seedUser(tenantId, "Multi User");

    await addCrewMember({ tenantId, crewId: crew1.id, userId });
    await addCrewMember({ tenantId, crewId: crew2.id, userId });

    const ids = await withTenant(tenantId, (tx) => listCrewIdsForUser(tx, tenantId, userId));
    expect(ids).toContain(crew1.id);
    expect(ids).toContain(crew2.id);
    expect(ids).toHaveLength(2);
  });
});

describe("cross-tenant RLS", () => {
  it("tenant-2's listCrews does NOT see tenant-1 crews", async () => {
    const t1 = await seedTenant();
    const t2 = await seedTenant();
    const c1 = await createCrew({ tenantId: t1, name: "T1 Crew" });

    const t2Crews = await listCrews(t2);
    expect(t2Crews.map((c) => c.id)).not.toContain(c1.id);
  });

  it("tenant-2's listCrewIdsForUser does NOT see tenant-1 user's crews", async () => {
    const t1 = await seedTenant();
    const t2 = await seedTenant();
    const u1 = await seedUser(t1, "T1 Worker");
    const c1 = await createCrew({ tenantId: t1, name: "T1 Only Crew" });
    await addCrewMember({ tenantId: t1, crewId: c1.id, userId: u1 });

    // Query as tenant-2 using tenant-1's userId — RLS should return nothing
    const ids = await withTenant(t2, (tx) => listCrewIdsForUser(tx, t2, u1));
    expect(ids).toHaveLength(0);
  });
});
