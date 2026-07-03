import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { adminDb, adminPool } from "../src/admin-client.js";
import { recomputeFounderMinutes } from "../src/index.js";
import { tenant, taskRegistry, taskHealth, taskException } from "../src/schema/index.js";

const T1 = 9660, T2 = 9661, T3 = 9662, TSTALE = 9663;
const SYN = [T1, T2, T3, TSTALE];
let tenantId: string;
const NOW = new Date("2026-07-02T12:00:00Z"); // window = last 30d -> cutoff 2026-06-02
const reg = (id: number) => ({ id, slug: `fm.${id}`, name: `fm-${id}`, phase: 5, defaultOwner: "HUMAN" as const, defaultMode: "full_auto" as const, scope: "per_job" as const });
const fm = (taskId: number) =>
  adminDb.select({ v: taskHealth.founderMinutes30d }).from(taskHealth).where(and(eq(taskHealth.tenantId, tenantId), eq(taskHealth.taskId, taskId))).then((r) => Number(r[0]?.v));

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "FM Co", publicKey: `fm-${Date.now()}`, clerkOrgId: `org_fm_${Date.now()}` }).returning();
  tenantId = t!.id;
  await adminDb.insert(taskRegistry).values(SYN.map(reg));
  await adminDb.insert(taskHealth).values([
    { tenantId, taskId: T1, status: "red", effectiveMode: "full_auto", founderMinutes30d: "0" },
    { tenantId, taskId: T2, status: "red", effectiveMode: "full_auto", founderMinutes30d: "0" },
    { tenantId, taskId: T3, status: "amber", effectiveMode: "full_auto", founderMinutes30d: "0" },
    { tenantId, taskId: TSTALE, status: "amber", effectiveMode: "full_auto", founderMinutes30d: "25" }, // stale value to be reset
  ]);
  await adminDb.insert(taskException).values([
    // T1: two resolved-in-window exceptions -> 10 + min(30,60) = 40
    { tenantId, taskId: T1, kind: "task_regression", severity: "medium", openedAt: new Date("2026-07-01T03:50:00Z"), firstViewedAt: new Date("2026-07-01T04:00:00Z"), resolvedAt: new Date("2026-07-01T04:10:00Z") },
    { tenantId, taskId: T1, kind: "task_regression", severity: "medium", openedAt: new Date("2026-07-01T04:50:00Z"), firstViewedAt: new Date("2026-07-01T05:00:00Z"), resolvedAt: new Date("2026-07-01T06:00:00Z") },
    // T2: resolved but never viewed -> 0
    { tenantId, taskId: T2, kind: "task_stale", severity: "medium", openedAt: new Date("2026-07-01T04:00:00Z"), resolvedAt: new Date("2026-07-01T04:10:00Z") },
    // T3: viewed+resolved but OUTSIDE the 30d window -> 0
    { tenantId, taskId: T3, kind: "task_regression", severity: "medium", openedAt: new Date("2026-05-01T03:50:00Z"), firstViewedAt: new Date("2026-05-01T04:00:00Z"), resolvedAt: new Date("2026-05-01T04:30:00Z") },
  ]);
});

afterAll(async () => {
  await adminDb.delete(taskException).where(eq(taskException.tenantId, tenantId));
  await adminDb.delete(taskHealth).where(eq(taskHealth.tenantId, tenantId));
  await adminDb.delete(taskRegistry).where(inArray(taskRegistry.id, SYN));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
  await adminPool.end();
});

describe("recomputeFounderMinutes", () => {
  it("sums capped in-window minutes per task, ignoring unviewed and out-of-window", async () => {
    await recomputeFounderMinutes(tenantId, { now: NOW });
    expect(await fm(T1)).toBe(40); // 10 + capped(60)=30
    expect(await fm(T2)).toBe(0); // never viewed
    expect(await fm(T3)).toBe(0); // resolved before the 30d window
  });

  it("resets a stale founder-minutes value when a task no longer qualifies", async () => {
    await recomputeFounderMinutes(tenantId, { now: NOW });
    expect(await fm(TSTALE)).toBe(0); // was 25, now nothing qualifies
  });
});
