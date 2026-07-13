import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb } from "../src/admin-client";
import { job } from "../src/schema/jobs";
import { lead } from "../src/schema/crm";
import { tenant } from "../src/schema/tenancy";
import { user } from "../src/schema/tenancy";
import { seedDemoTenant, resetDemoTenant } from "../src/lifecycle/demo-seed/reset";

// Hermetic isolation: own demo tenant per run (unique clerkOrgId), unpolluted by the singleton.
const SUFFIX = `reset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

describe("seedDemoTenant idempotency + reset", () => {
  it("running twice yields the same job/lead counts (no dupes)", async () => {
    const first = await seedDemoTenant({ keySuffix: SUFFIX });
    const jobs1 = await adminDb.select().from(job).where(eq(job.tenantId, first.tenantId));
    const leads1 = await adminDb.select().from(lead).where(eq(lead.tenantId, first.tenantId));

    const second = await seedDemoTenant({ keySuffix: SUFFIX });
    expect(second.tenantId).toBe(first.tenantId);

    const jobs2 = await adminDb.select().from(job).where(eq(job.tenantId, first.tenantId));
    const leads2 = await adminDb.select().from(lead).where(eq(lead.tenantId, first.tenantId));
    expect(jobs2.length).toBe(jobs1.length);
    expect(leads2.length).toBe(leads1.length);
  }, 180_000);

  it("reset (soft) removes pipeline data but keeps the tenant + staff", async () => {
    const soft = `${SUFFIX}-soft`;
    const { tenantId } = await seedDemoTenant({ keySuffix: soft });

    await resetDemoTenant(tenantId);

    const leads = await adminDb.select().from(lead).where(eq(lead.tenantId, tenantId));
    expect(leads).toHaveLength(0);
    const jobs = await adminDb.select().from(job).where(eq(job.tenantId, tenantId));
    expect(jobs).toHaveLength(0);

    const [t] = await adminDb.select().from(tenant).where(eq(tenant.id, tenantId));
    expect(t).toBeTruthy();
    const staff = await adminDb.select().from(user).where(eq(user.tenantId, tenantId));
    expect(staff.length).toBeGreaterThan(0);
  }, 180_000);

  it("reset (hard) also removes staff + the tenant row itself", async () => {
    const hardSuffix = `${SUFFIX}-hard`;
    const { tenantId } = await seedDemoTenant({ keySuffix: hardSuffix });

    await resetDemoTenant(tenantId, { hard: true });

    const [t] = await adminDb.select().from(tenant).where(eq(tenant.id, tenantId));
    expect(t).toBeUndefined();
    const staff = await adminDb.select().from(user).where(eq(user.tenantId, tenantId));
    expect(staff).toHaveLength(0);
  }, 180_000);

  it("refuses to reset a non-demo tenant", async () => {
    const notDemoSuffix = `${SUFFIX}-notdemo`;
    const { tenantId } = await seedDemoTenant({ keySuffix: notDemoSuffix });
    await adminDb.update(tenant).set({ demo: false }).where(eq(tenant.id, tenantId));

    await expect(resetDemoTenant(tenantId)).rejects.toThrow(/demo/i);

    // cleanup: flag back to demo so it doesn't linger as a non-demo orphan, then hard-reset.
    await adminDb.update(tenant).set({ demo: true }).where(eq(tenant.id, tenantId));
    await resetDemoTenant(tenantId, { hard: true });
  }, 180_000);
});
