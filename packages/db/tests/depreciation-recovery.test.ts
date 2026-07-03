import { describe, it, expect } from "vitest";
import { withTenant } from "../src/tenant.js";
import { adminDb } from "../src/admin-client.js";
import { detectDepreciationRecovery, DEPRECIATION_TASK_KEY } from "../src/lifecycle/depreciation-recovery.js";
import { job, claim, jobChecklistItem } from "../src/schema/index.js";
import { eq, and } from "drizzle-orm";
import { makeTenant, makeJobWithCustomer } from "./helpers.js";

async function seedInsuranceJob(opts: { rcvCents: number | null; acvCents: number | null }) {
  const { tenantId } = await makeTenant();
  const { jobId } = await makeJobWithCustomer(tenantId);
  await adminDb.update(job).set({ type: "insurance", stage: "complete" }).where(eq(job.id, jobId));
  await withTenant(tenantId, (tx) =>
    tx.insert(claim).values({ tenantId, jobId, rcvCents: opts.rcvCents, acvCents: opts.acvCents, status: "approved" }),
  );
  return { tenantId, jobId };
}

async function depreciationTasks(tenantId: string, jobId: string) {
  return withTenant(tenantId, (tx) =>
    tx.select().from(jobChecklistItem).where(and(eq(jobChecklistItem.jobId, jobId), eq(jobChecklistItem.key, DEPRECIATION_TASK_KEY))),
  );
}

describe("detectDepreciationRecovery", () => {
  it("creates the office-staff task when an insurance job has recoverable depreciation", async () => {
    const { tenantId, jobId } = await seedInsuranceJob({ rcvCents: 2_000_000, acvCents: 1_400_000 });
    const r = await detectDepreciationRecovery({ tenantId, jobId });
    expect(r).toMatchObject({ depreciationCents: 600_000 });
    const tasks = await depreciationTasks(tenantId, jobId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.ownerAgent).toBe("claims");
    expect(tasks[0]!.status).toBe("pending");
    expect(tasks[0]!.dueAt).not.toBeNull();
    expect((tasks[0]!.payload as { recoverableDepreciationCents?: number }).recoverableDepreciationCents).toBe(600_000);
  });

  it("skips a retail job (lane branch — retail has no depreciation recovery)", async () => {
    const { tenantId, jobId } = await makeTenant().then(async ({ tenantId }) => {
      const { jobId } = await makeJobWithCustomer(tenantId); // type defaults to retail
      await adminDb.update(job).set({ stage: "complete" }).where(eq(job.id, jobId));
      return { tenantId, jobId };
    });
    const r = await detectDepreciationRecovery({ tenantId, jobId });
    expect(r).toEqual({ skipped: "not_insurance" });
    expect(await depreciationTasks(tenantId, jobId)).toHaveLength(0);
  });

  it("skips when there is no recoverable depreciation (RCV == ACV)", async () => {
    const { tenantId, jobId } = await seedInsuranceJob({ rcvCents: 1_500_000, acvCents: 1_500_000 });
    const r = await detectDepreciationRecovery({ tenantId, jobId });
    expect(r).toEqual({ skipped: "no_depreciation" });
    expect(await depreciationTasks(tenantId, jobId)).toHaveLength(0);
  });

  it("is idempotent — a second call does not create a duplicate task", async () => {
    const { tenantId, jobId } = await seedInsuranceJob({ rcvCents: 2_000_000, acvCents: 1_400_000 });
    await detectDepreciationRecovery({ tenantId, jobId });
    const again = await detectDepreciationRecovery({ tenantId, jobId });
    expect(again).toEqual({ skipped: "already_exists" });
    expect(await depreciationTasks(tenantId, jobId)).toHaveLength(1);
  });
});
