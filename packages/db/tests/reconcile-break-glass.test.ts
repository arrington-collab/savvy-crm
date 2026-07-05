/**
 * Verifies that reconcileTaskExceptions forces break_glass=true + severity="high"
 * for tasks whose check_key is in BREAK_GLASS_ON_FAIL_CHECK_KEYS (cell 6),
 * regardless of dollar impact. Also asserts that tasks NOT in the set are
 * unaffected (break_glass stays false at $0 impact).
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { adminDb, adminPool } from "../src/admin-client.js";
import { reconcileTaskExceptions } from "../src/index.js";
import { tenant, taskRegistry, taskHealth, verificationRun, taskException } from "../src/schema/index.js";

// Synthetic task IDs unlikely to collide with real seed data.
const BG_TASK = 9910; // bound to comms.deliverability → break-glass on fail
const NO_BG_TASK = 9911; // bound to a non-listed key → no forced break-glass

let tenantId: string;

const reg = (id: number, checkKey: string) => ({
  id,
  slug: `bg.${id}`,
  name: `bg-task-${id}`,
  phase: 14,
  defaultOwner: "HUMAN" as const,
  defaultMode: "full_auto" as const,
  scope: "per_tenant_recurring" as const,
  checkKey,
});

const openRows = () =>
  adminDb
    .select()
    .from(taskException)
    .where(and(eq(taskException.tenantId, tenantId), isNull(taskException.resolvedAt)));

beforeAll(async () => {
  const [t] = await adminDb
    .insert(tenant)
    .values({ name: "BG-Test Co", publicKey: `bg-${Date.now()}`, clerkOrgId: `org_bg_${Date.now()}` })
    .returning();
  tenantId = t!.id;

  await adminDb.insert(taskRegistry).values([
    reg(BG_TASK, "comms.deliverability"),
    reg(NO_BG_TASK, "test.no_break_glass"),
  ]);

  // Both tasks are red (health) with a fail verification — simulates a check failure.
  await adminDb.insert(taskHealth).values([
    { tenantId, taskId: BG_TASK, status: "red", effectiveMode: "full_auto", openExceptionCount: 0 },
    { tenantId, taskId: NO_BG_TASK, status: "red", effectiveMode: "full_auto", openExceptionCount: 0 },
  ]);
  await adminDb.insert(verificationRun).values([
    { tenantId, taskId: BG_TASK, checkKey: "comms.deliverability", status: "fail" },
    { tenantId, taskId: NO_BG_TASK, checkKey: "test.no_break_glass", status: "fail" },
  ]);
});

afterAll(async () => {
  await adminDb.delete(taskException).where(eq(taskException.tenantId, tenantId));
  await adminDb.delete(verificationRun).where(eq(verificationRun.tenantId, tenantId));
  await adminDb.delete(taskHealth).where(eq(taskHealth.tenantId, tenantId));
  await adminDb.delete(taskRegistry).where(inArray(taskRegistry.id, [BG_TASK, NO_BG_TASK]));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
  await adminPool.end();
});

describe("reconcileTaskExceptions — break-glass forcing (cell 6)", () => {
  it("forces break_glass=true + severity=high for comms.deliverability even at $0 impact", async () => {
    const r = await reconcileTaskExceptions(tenantId);
    expect(r.opened).toBe(2);

    const rows = await openRows();
    const bgRow = rows.find((x) => x.taskId === BG_TASK)!;
    expect(bgRow, "break-glass row must exist").toBeDefined();
    expect(bgRow.breakGlass).toBe(true);
    expect(bgRow.severity).toBe("high");
    expect(bgRow.dollarImpactCents).toBe(0); // no invoice evidence, still forced
  });

  it("does NOT force break_glass for a task whose check_key is not in the set", async () => {
    const rows = await openRows();
    const noBgRow = rows.find((x) => x.taskId === NO_BG_TASK)!;
    expect(noBgRow, "non-break-glass row must exist").toBeDefined();
    expect(noBgRow.breakGlass).toBe(false); // threshold not met ($0 impact, no min_dollars set)
    expect(noBgRow.dollarImpactCents).toBe(0);
  });

  it("is idempotent — re-running keeps break_glass=true on the comms.deliverability row", async () => {
    const r = await reconcileTaskExceptions(tenantId);
    expect(r.opened).toBe(0); // already open, no new rows
    const rows = await openRows();
    const bgRow = rows.find((x) => x.taskId === BG_TASK)!;
    expect(bgRow.breakGlass).toBe(true);
    expect(bgRow.severity).toBe("high");
  });
});
