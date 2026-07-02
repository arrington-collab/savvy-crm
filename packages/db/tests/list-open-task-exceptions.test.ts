import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { adminDb, adminPool } from "../src/admin-client.js";
import { listOpenTaskExceptions } from "../src/index.js";
import { tenant, taskRegistry, taskException } from "../src/schema/index.js";

const HIGH = 9611, MED = 9612, RES = 9613;
const SYN = [HIGH, MED, RES];
let tenantId: string;
const reg = (id: number, name: string) => ({ id, slug: `oe.${id}`, name, phase: 5, defaultOwner: "HUMAN" as const, defaultMode: "full_auto" as const, scope: "per_job" as const });

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "OE Co", publicKey: `oe-${Date.now()}`, clerkOrgId: `org_oe_${Date.now()}` }).returning();
  tenantId = t!.id;
  await adminDb.insert(taskRegistry).values([reg(HIGH, "Invoice generation"), reg(MED, "Booking"), reg(RES, "Old resolved")]);
  await adminDb.insert(taskException).values([
    { tenantId, taskId: MED, kind: "task_stale", severity: "medium", dollarImpactCents: 0, openedAt: new Date("2026-07-01T04:00:00Z") },
    { tenantId, taskId: HIGH, kind: "verification_mismatch", severity: "high", dollarImpactCents: 250_000, breakGlass: true, openedAt: new Date("2026-07-02T04:00:00Z") },
    { tenantId, taskId: RES, kind: "task_regression", severity: "high", openedAt: new Date("2026-06-30T04:00:00Z"), resolvedAt: new Date("2026-07-01T04:00:00Z") },
  ]);
});

afterAll(async () => {
  await adminDb.delete(taskException).where(eq(taskException.tenantId, tenantId));
  await adminDb.delete(taskRegistry).where(inArray(taskRegistry.id, SYN));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
  await adminPool.end();
});

describe("listOpenTaskExceptions", () => {
  it("returns only open exceptions, joined to the task name, high-severity first", async () => {
    const rows = await listOpenTaskExceptions(tenantId);
    expect(rows.map((r) => r.taskId)).toEqual([HIGH, MED]); // RES (resolved) excluded; high before medium
    expect(rows[0]!.name).toBe("Invoice generation");
    expect(rows[0]!.severity).toBe("high");
    expect(rows[0]!.dollarImpactCents).toBe(250_000);
    expect(rows[0]!.breakGlass).toBe(true);
    expect(rows[0]!.firstViewedAt).toBeNull();
    expect(rows[1]!.name).toBe("Booking");
    expect(rows[1]!.kind).toBe("task_stale");
  });
});
