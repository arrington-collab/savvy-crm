import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { adminDb, adminPool } from "../src/admin-client.js";
import { reconcileTaskExceptions } from "../src/index.js";
import { tenant, taskRegistry, taskHealth, verificationRun, taskException } from "../src/schema/index.js";

const RED = 9901, STALE = 9902;
const SYN = [RED, STALE];
let tenantId: string;
const reg = (id: number) => ({ id, slug: `rx.${id}`, name: `x-${id}`, phase: 7, defaultOwner: "HUMAN" as const, defaultMode: "full_auto" as const, scope: "per_job" as const, checkKey: `test.${id}` });
const openRows = () => adminDb.select().from(taskException).where(and(eq(taskException.tenantId, tenantId), isNull(taskException.resolvedAt)));

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "RX Co", publicKey: `rx-${Date.now()}`, clerkOrgId: `org_rx_${Date.now()}` }).returning();
  tenantId = t!.id;
  await adminDb.insert(taskRegistry).values(SYN.map(reg));
  await adminDb.insert(taskHealth).values([
    { tenantId, taskId: RED, status: "red", effectiveMode: "full_auto", openExceptionCount: 1 },
    { tenantId, taskId: STALE, status: "amber", effectiveMode: "full_auto", openExceptionCount: 0 },
  ]);
  await adminDb.insert(verificationRun).values([
    { tenantId, taskId: RED, checkKey: "test.9901", status: "fail" },
    { tenantId, taskId: STALE, checkKey: "test.9902", status: "stale" },
  ]);
});

afterAll(async () => {
  await adminDb.delete(taskException).where(eq(taskException.tenantId, tenantId));
  await adminDb.delete(verificationRun).where(eq(verificationRun.tenantId, tenantId));
  await adminDb.delete(taskHealth).where(eq(taskHealth.tenantId, tenantId));
  await adminDb.delete(taskRegistry).where(inArray(taskRegistry.id, SYN));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
  await adminPool.end();
});

describe("reconcileTaskExceptions", () => {
  it("opens a persisted row for each currently-unhealthy task", async () => {
    const r = await reconcileTaskExceptions(tenantId);
    expect(r.opened).toBe(2);
    const rows = await openRows();
    expect(rows.map((x) => x.taskId).sort((a, b) => a - b)).toEqual([RED, STALE]);
    const red = rows.find((x) => x.taskId === RED)!;
    expect(red.kind).toBe("verification_mismatch");
    expect(red.openedAt).not.toBeNull();
  });

  it("is idempotent — re-running does not duplicate and preserves opened_at", async () => {
    const before = (await openRows()).find((x) => x.taskId === RED)!.openedAt;
    const r = await reconcileTaskExceptions(tenantId);
    expect(r.opened).toBe(0);
    const rows = await openRows();
    expect(rows).toHaveLength(2);
    expect(rows.find((x) => x.taskId === RED)!.openedAt).toEqual(before);
  });

  it("resolves an exception when its task recovers to green", async () => {
    await adminDb.update(taskHealth).set({ status: "green", openExceptionCount: 0 }).where(and(eq(taskHealth.tenantId, tenantId), eq(taskHealth.taskId, RED)));
    const r = await reconcileTaskExceptions(tenantId);
    expect(r.resolved).toBe(1);
    const rows = await openRows();
    expect(rows.map((x) => x.taskId)).toEqual([STALE]); // RED resolved, STALE still open
    const [resolvedRed] = await adminDb.select().from(taskException).where(and(eq(taskException.tenantId, tenantId), eq(taskException.taskId, RED)));
    expect(resolvedRed!.resolvedAt).not.toBeNull();
  });
});
