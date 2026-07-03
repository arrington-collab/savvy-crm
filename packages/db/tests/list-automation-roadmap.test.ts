import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { adminDb, adminPool } from "../src/admin-client.js";
import { listAutomationRoadmap } from "../src/index.js";
import { tenant, taskRegistry, taskHealth } from "../src/schema/index.js";

// M1/M2 are manual-with-time (roadmap), A1 assisted-with-time, AUTO is full_auto
// (excluded), ZERO is manual but no logged time (excluded).
const M1 = 9671, M2 = 9672, A1 = 9673, AUTO = 9674, ZERO = 9675;
const SYN = [M1, M2, A1, AUTO, ZERO];
let tenantId: string;
const reg = (id: number, phase: number, name: string) => ({ id, slug: `ar.${id}`, name, phase, defaultOwner: "HUMAN" as const, defaultMode: "manual" as const, scope: "per_job" as const });

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "AR Co", publicKey: `ar-${Date.now()}`, clerkOrgId: `org_ar_${Date.now()}` }).returning();
  tenantId = t!.id;
  await adminDb.insert(taskRegistry).values([reg(M1, 9, "Invoice generation"), reg(M2, 2, "Booking"), reg(A1, 4, "Estimate"), reg(AUTO, 5, "Auto task"), reg(ZERO, 6, "Idle manual")]);
  await adminDb.insert(taskHealth).values([
    { tenantId, taskId: M1, status: "amber", effectiveMode: "manual", founderMinutes30d: "45" },
    { tenantId, taskId: M2, status: "red", effectiveMode: "manual", founderMinutes30d: "20" },
    { tenantId, taskId: A1, status: "amber", effectiveMode: "assisted", founderMinutes30d: "80" },
    { tenantId, taskId: AUTO, status: "green", effectiveMode: "full_auto", founderMinutes30d: "999" }, // excluded: full_auto
    { tenantId, taskId: ZERO, status: "gray", effectiveMode: "manual", founderMinutes30d: "0" }, // excluded: no time logged
  ]);
});

afterAll(async () => {
  await adminDb.delete(taskHealth).where(eq(taskHealth.tenantId, tenantId));
  await adminDb.delete(taskRegistry).where(inArray(taskRegistry.id, SYN));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
  await adminPool.end();
});

describe("listAutomationRoadmap", () => {
  it("ranks manual/assisted tasks by founder-minutes desc, excluding full_auto and zero-time", async () => {
    const rows = await listAutomationRoadmap(tenantId);
    expect(rows.map((r) => r.taskId)).toEqual([A1, M1, M2]); // 80, 45, 20; AUTO + ZERO excluded
    expect(rows[0]!.name).toBe("Estimate");
    expect(rows[0]!.founderMinutes30d).toBe(80);
    expect(typeof rows[0]!.founderMinutes30d).toBe("number");
    expect(rows[0]!.effectiveMode).toBe("assisted");
    expect(rows[0]!.healthStatus).toBe("amber");
  });

  it("respects the limit", async () => {
    const rows = await listAutomationRoadmap(tenantId, 2);
    expect(rows.map((r) => r.taskId)).toEqual([A1, M1]);
  });
});
