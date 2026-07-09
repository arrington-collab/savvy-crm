import { describe, it, expect } from "vitest";
import { withTenant } from "../src/tenant.js";
import { adminDb } from "../src/admin-client.js";
import { advanceJobStageForward } from "../src/lifecycle/advance-stage.js";
import { job, appointment, document, estimate } from "../src/schema/index.js";
import { eq } from "drizzle-orm";
import { makeTenant, makeJobWithCustomer } from "./helpers.js";
import type { JobStage } from "@savvy/core";

async function seedJobAt(stage: JobStage): Promise<{ tenantId: string; jobId: string; propertyId: string | null }> {
  const { tenantId } = await makeTenant();
  const { jobId } = await makeJobWithCustomer(tenantId);
  const [j] = await adminDb.update(job).set({ stage }).where(eq(job.id, jobId)).returning({ propertyId: job.propertyId });
  return { tenantId, jobId, propertyId: j?.propertyId ?? null };
}

// Full contiguous evidence chain through 'production' — the evidence-derived
// stage gate (Task 3) requires the whole chain from 'inspected' up, not just
// the target stage's own evidence, before a job can advance to 'production'.
async function seedProductionEvidence(tenantId: string, jobId: string, propertyId: string | null): Promise<void> {
  await adminDb.insert(document).values({ tenantId, jobId, propertyId: propertyId ?? undefined, kind: "photo", r2Key: `${tenantId}/${jobId}/insp.jpg` });
  await adminDb.insert(estimate).values({ tenantId, jobId, propertyId: propertyId ?? undefined, status: "accepted", lineItems: [] });
  await adminDb.insert(appointment).values({
    tenantId, jobId, type: "crew", status: "scheduled",
    startsAt: new Date(), endsAt: new Date(Date.now() + 3_600_000),
  });
}

describe("advanceJobStageForward", () => {
  it("advances a job forward and records the stage", async () => {
    const { tenantId, jobId, propertyId } = await seedJobAt("approved");
    await seedProductionEvidence(tenantId, jobId, propertyId);
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
    const { tenantId, jobId, propertyId } = await seedJobAt("approved");
    await seedProductionEvidence(tenantId, jobId, propertyId);
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
