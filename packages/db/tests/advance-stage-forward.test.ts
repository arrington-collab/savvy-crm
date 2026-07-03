import { describe, it, expect } from "vitest";
import { withTenant } from "../src/tenant.js";
import { adminDb } from "../src/admin-client.js";
import { advanceJobStageForward } from "../src/lifecycle/advance-stage.js";
import { job } from "../src/schema/index.js";
import { eq } from "drizzle-orm";
import { makeTenant, makeJobWithCustomer } from "./helpers.js";
import type { JobStage } from "@savvy/core";

async function seedJobAt(stage: JobStage): Promise<{ tenantId: string; jobId: string }> {
  const { tenantId } = await makeTenant();
  const { jobId } = await makeJobWithCustomer(tenantId);
  await adminDb.update(job).set({ stage }).where(eq(job.id, jobId));
  return { tenantId, jobId };
}

describe("advanceJobStageForward", () => {
  it("advances a job forward and records the stage", async () => {
    const { tenantId, jobId } = await seedJobAt("approved");
    const r = await withTenant(tenantId, (tx) =>
      advanceJobStageForward(tx, { tenantId, jobId, toStage: "production", byAgent: "scheduling" }),
    );
    expect(r).toMatchObject({ toStage: "production" });
    const [j] = await adminDb.select({ stage: job.stage }).from(job).where(eq(job.id, jobId));
    expect(j!.stage).toBe("production");
  });

  it("is forward-only: skips when target is not ahead of the current stage", async () => {
    const { tenantId, jobId } = await seedJobAt("closeout");
    const r = await withTenant(tenantId, (tx) =>
      advanceJobStageForward(tx, { tenantId, jobId, toStage: "production", byAgent: "scheduling" }),
    );
    expect(r).toMatchObject({ skipped: "not_forward" });
    const [j] = await adminDb.select({ stage: job.stage }).from(job).where(eq(job.id, jobId));
    expect(j!.stage).toBe("closeout");
  });

  it("is idempotent: a second identical advance skips as not_forward", async () => {
    const { tenantId, jobId } = await seedJobAt("approved");
    await withTenant(tenantId, (tx) =>
      advanceJobStageForward(tx, { tenantId, jobId, toStage: "production", byAgent: "scheduling" }),
    );
    const again = await withTenant(tenantId, (tx) =>
      advanceJobStageForward(tx, { tenantId, jobId, toStage: "production", byAgent: "scheduling" }),
    );
    expect(again).toMatchObject({ skipped: "not_forward" });
  });

  it("returns skipped: no_job when the job does not exist", async () => {
    const { tenantId } = await seedJobAt("approved");
    const r = await withTenant(tenantId, (tx) =>
      advanceJobStageForward(tx, { tenantId, jobId: "00000000-0000-0000-0000-000000000000", toStage: "production", byAgent: "scheduling" }),
    );
    expect(r).toEqual({ skipped: "no_job" });
  });
});
