import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { adminDb, adminPool } from "../src/admin-client.js";
import { markTaskExceptionViewed } from "../src/index.js";
import { tenant, taskRegistry, taskException } from "../src/schema/index.js";

const VIEW = 9621, NONE = 9622;
const SYN = [VIEW, NONE];
let tenantId: string;
const reg = (id: number) => ({ id, slug: `mv.${id}`, name: `mv-${id}`, phase: 5, defaultOwner: "HUMAN" as const, defaultMode: "full_auto" as const, scope: "per_job" as const });
const firstViewedAt = (taskId: number) =>
  adminDb.select({ v: taskException.firstViewedAt }).from(taskException).where(and(eq(taskException.tenantId, tenantId), eq(taskException.taskId, taskId))).then((r) => r[0]?.v ?? null);

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "MV Co", publicKey: `mv-${Date.now()}`, clerkOrgId: `org_mv_${Date.now()}` }).returning();
  tenantId = t!.id;
  await adminDb.insert(taskRegistry).values(SYN.map(reg));
  // VIEW has an open, not-yet-viewed exception; NONE has none.
  await adminDb.insert(taskException).values({ tenantId, taskId: VIEW, kind: "verification_mismatch", severity: "high", openedAt: new Date("2026-07-02T04:00:00Z") });
});

afterAll(async () => {
  await adminDb.delete(taskException).where(eq(taskException.tenantId, tenantId));
  await adminDb.delete(taskRegistry).where(inArray(taskRegistry.id, SYN));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
  await adminPool.end();
});

describe("markTaskExceptionViewed", () => {
  it("stamps first_viewed_at on the first view and reports it stamped", async () => {
    expect(await firstViewedAt(VIEW)).toBeNull();
    const stamped = await markTaskExceptionViewed(tenantId, VIEW);
    expect(stamped).toBe(true);
    expect(await firstViewedAt(VIEW)).not.toBeNull();
  });

  it("is idempotent — a second view does not overwrite first_viewed_at and reports no change", async () => {
    const before = await firstViewedAt(VIEW);
    const stamped = await markTaskExceptionViewed(tenantId, VIEW);
    expect(stamped).toBe(false);
    expect(await firstViewedAt(VIEW)).toEqual(before);
  });

  it("reports no change when the task has no open exception", async () => {
    expect(await markTaskExceptionViewed(tenantId, NONE)).toBe(false);
  });
});
