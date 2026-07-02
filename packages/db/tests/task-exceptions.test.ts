import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { adminDb, adminPool } from "../src/admin-client.js";
import { computeTaskExceptions } from "../src/index.js";
import { tenant, taskRegistry, taskHealth, verificationRun } from "../src/schema/index.js";

const MISMATCH = 9601, STALE = 9602, HEALTHY = 9603;
const SYN = [MISMATCH, STALE, HEALTHY];
let tenantId: string;
const reg = (id: number, est: string) => ({ id, slug: `te.${id}`, name: `Task ${id}`, phase: 7, defaultOwner: "HUMAN" as const, defaultMode: "full_auto" as const, scope: "per_job" as const, checkKey: `test.${id}`, estFounderMinutes: est });

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "TE Co", publicKey: `te-${Date.now()}`, clerkOrgId: `org_te_${Date.now()}` }).returning();
  tenantId = t!.id;
  await adminDb.insert(taskRegistry).values([reg(MISMATCH, "20"), reg(STALE, "5"), reg(HEALTHY, "50")]);
  await adminDb.insert(taskHealth).values([
    { tenantId, taskId: MISMATCH, status: "red", effectiveMode: "full_auto", openExceptionCount: 1 }, // done-but-wrong
    { tenantId, taskId: STALE, status: "amber", effectiveMode: "full_auto", openExceptionCount: 0 },
    { tenantId, taskId: HEALTHY, status: "green", effectiveMode: "full_auto", openExceptionCount: 0 }, // excluded
  ]);
  await adminDb.insert(verificationRun).values([
    { tenantId, taskId: MISMATCH, checkKey: "test.9601", status: "fail" },
    { tenantId, taskId: STALE, checkKey: "test.9602", status: "stale" },
    { tenantId, taskId: HEALTHY, checkKey: "test.9603", status: "pass" },
  ]);
});

afterAll(async () => {
  await adminDb.delete(verificationRun).where(eq(verificationRun.tenantId, tenantId));
  await adminDb.delete(taskHealth).where(eq(taskHealth.tenantId, tenantId));
  await adminDb.delete(taskRegistry).where(inArray(taskRegistry.id, SYN));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
  await adminPool.end();
});

describe("computeTaskExceptions", () => {
  it("surfaces amber/red tasks as ranked exceptions, excluding green, classified by state", async () => {
    const exceptions = await computeTaskExceptions(tenantId);
    const mine = exceptions.filter((e) => SYN.includes(e.taskId));
    expect(mine.map((e) => e.taskId)).toEqual([MISMATCH, STALE]); // high (mismatch) before medium (stale); green excluded
    const byId = Object.fromEntries(mine.map((e) => [e.taskId, e]));
    expect(byId[MISMATCH]!.kind).toBe("verification_mismatch");
    expect(byId[MISMATCH]!.severity).toBe("high");
    expect(byId[STALE]!.kind).toBe("task_stale");
    expect(byId[STALE]!.estFounderMinutes).toBe(5);
  });
});
