import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { adminDb, adminPool } from "../src/admin-client.js";
import { computeTenantRollup } from "../src/index.js";
import { tenant, customer, property, job, taskRegistry, taskHealth, tenantOpsRollup } from "../src/schema/index.js";

const A = 9801, B = 9802, C = 9803, D = 9804;
const SYN = [A, B, C, D];
let tenantId: string;
const reg = (id: number) => ({ id, slug: `rl.${id}`, name: `r-${id}`, phase: 7, defaultOwner: "HUMAN" as const, defaultMode: "full_auto" as const, scope: "per_job" as const });
const DAYS = (n: number) => new Date(Date.now() - n * 86_400_000);

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "RL Co", publicKey: `rl-${Date.now()}`, clerkOrgId: `org_rl_${Date.now()}` }).returning();
  tenantId = t!.id;
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "HO" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "1 Main" }).returning();
  // 2 jobs in the 30d window, 1 older.
  await adminDb.insert(job).values([
    { tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "billing" },
    { tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "billing" },
    { tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "billing", createdAt: DAYS(40) },
  ]);
  await adminDb.insert(taskRegistry).values(SYN.map(reg));
  await adminDb.insert(taskHealth).values([
    { tenantId, taskId: A, status: "green", effectiveMode: "full_auto", openExceptionCount: 0, founderMinutes30d: "0" },
    { tenantId, taskId: B, status: "green", effectiveMode: "assisted", openExceptionCount: 0, founderMinutes30d: "0" },
    { tenantId, taskId: C, status: "amber", effectiveMode: "full_auto", openExceptionCount: 0, founderMinutes30d: "0" },
    { tenantId, taskId: D, status: "red", effectiveMode: "full_auto", openExceptionCount: 2, founderMinutes30d: "10" },
  ]);
});

afterAll(async () => {
  await adminDb.delete(tenantOpsRollup).where(eq(tenantOpsRollup.tenantId, tenantId));
  await adminDb.delete(taskHealth).where(eq(taskHealth.tenantId, tenantId));
  await adminDb.delete(taskRegistry).where(inArray(taskRegistry.id, SYN));
  await adminDb.delete(job).where(eq(job.tenantId, tenantId));
  await adminDb.delete(property).where(eq(property.tenantId, tenantId));
  await adminDb.delete(customer).where(eq(customer.tenantId, tenantId));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
  await adminPool.end();
});

describe("computeTenantRollup", () => {
  it("snapshots coverage, status breakdown, exceptions and 30d job count", async () => {
    await computeTenantRollup(tenantId);
    const [r] = await adminDb.select().from(tenantOpsRollup).where(eq(tenantOpsRollup.tenantId, tenantId));
    expect(r!.fullAutoGreen).toBe(1); // only A (green + full_auto); B is green but assisted
    expect(r!.greenCount).toBe(2);
    expect(r!.amberCount).toBe(1);
    expect(r!.redCount).toBe(1);
    expect(r!.openExceptionCount).toBe(2);
    expect(r!.founderMinutes30d).toBe("10");
    expect(r!.jobs30d).toBe(2); // the 40d-old job is excluded
    expect(r!.totalTasks).toBeGreaterThanOrEqual(4);
  });

  it("is idempotent — re-running upserts the single tenant row", async () => {
    await computeTenantRollup(tenantId);
    const rows = await adminDb.select().from(tenantOpsRollup).where(eq(tenantOpsRollup.tenantId, tenantId));
    expect(rows).toHaveLength(1);
  });
});
