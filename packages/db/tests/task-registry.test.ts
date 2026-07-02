import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb, adminPool } from "../src/admin-client.js";
import { pool } from "../src/client.js";
import { withTenant } from "../src/tenant.js";
import {
  tenant, customer, property, job,
  taskRegistry, tenantTaskConfig, jobTask, verificationRun, taskHealth,
} from "../src/schema/index.js";

// A registry id well outside the real 1–212 seed range so this test never
// collides with seeded data.
const TEST_TASK_ID = 90001;

let tenantAId: string;
let tenantBId: string;
let jobBId: string;

beforeAll(async () => {
  const [a] = await adminDb.insert(tenant).values({ name: "REG-A", publicKey: "reg-a", clerkOrgId: "org_reg_a" }).returning();
  const [b] = await adminDb.insert(tenant).values({ name: "REG-B", publicKey: "reg-b", clerkOrgId: "org_reg_b" }).returning();
  tenantAId = a!.id; tenantBId = b!.id;

  // Global registry row (no tenant) — both tenants should see it.
  await adminDb.insert(taskRegistry).values({
    id: TEST_TASK_ID, slug: "test.registry.row", name: "Test registry task",
    phase: 1, defaultOwner: "SAGE", defaultMode: "full_auto", scope: "per_job",
  });

  // Tenant B gets rows in every RLS table so A must not see them.
  const [cb] = await adminDb.insert(customer).values({ tenantId: b!.id, name: "REG-B-cust" }).returning();
  const [pb] = await adminDb.insert(property).values({ tenantId: b!.id, customerId: cb!.id, address: "REG-B-prop" }).returning();
  const [jb] = await adminDb.insert(job).values({ tenantId: b!.id, customerId: cb!.id, propertyId: pb!.id }).returning();
  jobBId = jb!.id;

  await adminDb.insert(tenantTaskConfig).values({ tenantId: b!.id, taskId: TEST_TASK_ID, mode: "assisted", enabled: false });
  await adminDb.insert(jobTask).values({ tenantId: b!.id, jobId: jb!.id, taskId: TEST_TASK_ID, status: "done" });
  await adminDb.insert(verificationRun).values({ tenantId: b!.id, taskId: TEST_TASK_ID, checkKey: "test.check", status: "pass" });
  await adminDb.insert(taskHealth).values({ tenantId: b!.id, taskId: TEST_TASK_ID, status: "green", effectiveMode: "full_auto" });
});

afterAll(async () => {
  await adminDb.delete(jobTask).where(eq(jobTask.tenantId, tenantBId));
  await adminDb.delete(verificationRun).where(eq(verificationRun.tenantId, tenantBId));
  await adminDb.delete(taskHealth).where(eq(taskHealth.tenantId, tenantBId));
  await adminDb.delete(tenantTaskConfig).where(eq(tenantTaskConfig.tenantId, tenantBId));
  await adminDb.delete(job).where(eq(job.tenantId, tenantBId));
  await adminDb.delete(property).where(eq(property.tenantId, tenantBId));
  await adminDb.delete(customer).where(eq(customer.tenantId, tenantBId));
  await adminDb.delete(taskRegistry).where(eq(taskRegistry.id, TEST_TASK_ID));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantAId));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantBId));
  await pool.end();
  await adminPool.end();
});

describe("task registry schema", () => {
  it("task_registry is global — visible to every tenant (no RLS)", async () => {
    const fromA = await withTenant(tenantAId, (tx) => tx.select().from(taskRegistry).where(eq(taskRegistry.id, TEST_TASK_ID)));
    const fromB = await withTenant(tenantBId, (tx) => tx.select().from(taskRegistry).where(eq(taskRegistry.id, TEST_TASK_ID)));
    expect(fromA.length).toBe(1);
    expect(fromB.length).toBe(1);
    expect(fromA[0]!.slug).toBe("test.registry.row");
  });

  it("tenant_task_config is tenant-scoped (A cannot see B's config)", async () => {
    const rows = await withTenant(tenantAId, (tx) => tx.select().from(tenantTaskConfig));
    expect(rows.some((r) => r.tenantId === tenantBId)).toBe(false);
  });

  it("job_task (registry instance) is tenant-scoped (A cannot see B)", async () => {
    const rows = await withTenant(tenantAId, (tx) => tx.select().from(jobTask));
    expect(rows.some((r) => r.tenantId === tenantBId)).toBe(false);
  });

  it("verification_run is tenant-scoped (A cannot see B)", async () => {
    const rows = await withTenant(tenantAId, (tx) => tx.select().from(verificationRun));
    expect(rows.some((r) => r.tenantId === tenantBId)).toBe(false);
  });

  it("task_health is tenant-scoped (A cannot see B's scoreboard)", async () => {
    const rows = await withTenant(tenantAId, (tx) => tx.select().from(taskHealth));
    expect(rows.some((r) => r.tenantId === tenantBId)).toBe(false);
  });

  it("job_task INSERT with mismatched tenant_id is rejected by WITH CHECK", async () => {
    await expect(
      withTenant(tenantAId, (tx) =>
        tx.insert(jobTask).values({ tenantId: tenantBId, jobId: jobBId, taskId: TEST_TASK_ID }),
      ),
    ).rejects.toThrow();
  });

  it("tenant carries scoreboard defaults (timezone, digest_times, break_glass)", async () => {
    const [t] = await adminDb.select().from(tenant).where(eq(tenant.id, tenantAId));
    expect(t!.timezone).toBe("America/Phoenix");
    expect(t!.digestTimes).toEqual(["07:00", "17:00"]);
    expect(t!.breakGlass).toEqual({ min_dollars: 10000, deadline_hours: 48 });
  });
});
