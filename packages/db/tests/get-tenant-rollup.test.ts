import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb, adminPool } from "../src/admin-client.js";
import { getTenantRollup } from "../src/index.js";
import { tenant, tenantOpsRollup } from "../src/schema/index.js";

let withRollup: string; // tenant that has a snapshot
let noRollup: string; // tenant with no snapshot yet (pre-first-sweep)

beforeAll(async () => {
  const [a] = await adminDb.insert(tenant).values({ name: "GR-a", publicKey: `gra-${Date.now()}`, clerkOrgId: `org_gra_${Date.now()}` }).returning();
  const [b] = await adminDb.insert(tenant).values({ name: "GR-b", publicKey: `grb-${Date.now()}`, clerkOrgId: `org_grb_${Date.now()}` }).returning();
  withRollup = a!.id; noRollup = b!.id;
  await adminDb.insert(tenantOpsRollup).values({
    tenantId: withRollup, fullAutoGreen: 40, totalTasks: 212, greenCount: 55, amberCount: 8, redCount: 3,
    openExceptionCount: 11, jobs30d: 20, founderMinutes30d: "120", computedAt: new Date("2026-07-02T04:00:00Z"),
  });
});

afterAll(async () => {
  await adminDb.delete(tenantOpsRollup).where(eq(tenantOpsRollup.tenantId, withRollup));
  await adminDb.delete(tenant).where(eq(tenant.id, withRollup));
  await adminDb.delete(tenant).where(eq(tenant.id, noRollup));
  await adminPool.end();
});

describe("getTenantRollup", () => {
  it("returns the tenant's snapshot with founder-minutes coerced to a number", async () => {
    const r = await getTenantRollup(withRollup);
    expect(r).not.toBeNull();
    expect(r!.fullAutoGreen).toBe(40);
    expect(r!.totalTasks).toBe(212);
    expect(r!.greenCount).toBe(55);
    expect(r!.amberCount).toBe(8);
    expect(r!.redCount).toBe(3);
    expect(r!.openExceptionCount).toBe(11);
    expect(r!.jobs30d).toBe(20);
    expect(r!.founderMinutes30d).toBe(120); // numeric column -> number, not "120"
    expect(typeof r!.founderMinutes30d).toBe("number");
    expect(r!.computedAt).toEqual(new Date("2026-07-02T04:00:00Z"));
  });

  it("returns null when the tenant has no snapshot yet", async () => {
    expect(await getTenantRollup(noRollup)).toBeNull();
  });
});
