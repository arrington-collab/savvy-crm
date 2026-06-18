import { afterAll, describe, it, expect } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { adminDb, adminPool } from "../admin-client.js";
import { pool } from "../client.js";
import { tenant, user } from "../schema/index.js";
import { ensureTenantForOrg, ensureUser, deactivateUserByClerkId } from "./provisioning.js";

const orgIds: string[] = [];
function org() { const id = `org_${crypto.randomUUID()}`; orgIds.push(id); return id; }

afterAll(async () => {
  const ids = await adminDb.select({ id: tenant.id }).from(tenant).where(inArray(tenant.clerkOrgId, orgIds));
  const tids = ids.map((r) => r.id);
  if (tids.length) {
    await adminDb.delete(user).where(inArray(user.tenantId, tids));
    await adminDb.delete(tenant).where(inArray(tenant.id, tids));
  }
  await pool.end();
  await adminPool.end();
});

describe("provisioning", () => {
  it("ensureTenantForOrg creates once, then is idempotent", async () => {
    const o = org();
    const a = await ensureTenantForOrg({ clerkOrgId: o, name: "Acme" });
    expect(a.created).toBe(true);
    expect(a.publicKey.length).toBeGreaterThan(6);
    const b = await ensureTenantForOrg({ clerkOrgId: o, name: "Acme" });
    expect(b.created).toBe(false);
    expect(b.id).toBe(a.id);
  });

  it("ensureUser inserts, then updates name/email + syncs role (owner sticky)", async () => {
    const o = org();
    const { id: tenantId } = await ensureTenantForOrg({ clerkOrgId: o, name: "T" });
    const cuid = `user_${crypto.randomUUID()}`;
    const ins = await ensureUser({ tenantId, clerkUserId: cuid, name: "A", email: "a@x.com", role: "owner" });
    expect(ins.created).toBe(true);
    const up = await ensureUser({ tenantId, clerkUserId: cuid, name: "A2", email: "a2@x.com", role: "admin" });
    expect(up.created).toBe(false);
    const [row] = await adminDb.select().from(user).where(eq(user.id, ins.id));
    expect(row!.role).toBe("owner");      // sticky
    expect(row!.name).toBe("A2");          // updated
    const cuid2 = `user_${crypto.randomUUID()}`;
    const r1 = await ensureUser({ tenantId, clerkUserId: cuid2, name: "B", email: "b@x.com", role: "rep" });
    await ensureUser({ tenantId, clerkUserId: cuid2, name: "B", email: "b@x.com", role: "admin" });
    const [row2] = await adminDb.select().from(user).where(eq(user.id, r1.id));
    expect(row2!.role).toBe("admin");      // non-sticky syncs
  });

  it("deactivateUserByClerkId sets deactivatedAt; ensureUser reactivates", async () => {
    const o = org();
    const { id: tenantId } = await ensureTenantForOrg({ clerkOrgId: o, name: "T" });
    const cuid = `user_${crypto.randomUUID()}`;
    const { id } = await ensureUser({ tenantId, clerkUserId: cuid, name: "C", email: "c@x.com", role: "rep" });
    const d = await deactivateUserByClerkId({ tenantId, clerkUserId: cuid });
    expect(d.deactivated).toBe(true);
    let [row] = await adminDb.select().from(user).where(eq(user.id, id));
    expect(row!.deactivatedAt).not.toBeNull();
    await ensureUser({ tenantId, clerkUserId: cuid, name: "C", email: "c@x.com", role: "rep" });
    [row] = await adminDb.select().from(user).where(eq(user.id, id));
    expect(row!.deactivatedAt).toBeNull();
  });
});
