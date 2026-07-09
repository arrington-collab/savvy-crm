import { afterAll, expect, it } from "vitest";
import { withTenant } from "../src/tenant.js";
import { adminDb, adminPool, eq, recordStageChange, StageEvidenceError, BackwardNeedsReasonError } from "../src/index.js";
import { tenant, job, estimate, document, jobStageEvent } from "../src/schema/index.js";
import { makeTenant, makeJobWithProperty } from "./helpers.js";

const tids: string[] = [];
afterAll(async () => { for (const t of tids) await adminDb.delete(tenant).where(eq(tenant.id, t)).catch(() => {}); await adminPool.end(); });

async function jobAt(stage: string) {
  const { tenantId } = await makeTenant(); tids.push(tenantId);
  const { jobId, propertyId } = await makeJobWithProperty(tenantId);
  await adminDb.update(job).set({ stage: stage as never }).where(eq(job.id, jobId));
  return { tenantId, jobId, propertyId };
}

it("forward to inspected without inspection evidence is REJECTED", async () => {
  const { tenantId, jobId } = await jobAt("lead");
  await expect(withTenant(tenantId, (tx) => recordStageChange(tx, { tenantId, jobId, toStage: "inspected" })))
    .rejects.toBeInstanceOf(StageEvidenceError);
});

it("forward to estimate without an estimate is REJECTED even with inspection", async () => {
  const { tenantId, jobId, propertyId } = await jobAt("inspected");
  await adminDb.insert(document).values({ tenantId, jobId, propertyId, kind: "photo", r2Key: "k" }); // satisfies inspected
  await expect(withTenant(tenantId, (tx) => recordStageChange(tx, { tenantId, jobId, toStage: "estimate" })))
    .rejects.toBeInstanceOf(StageEvidenceError);
});

it("forward passes when the contiguous chain is present", async () => {
  const { tenantId, jobId, propertyId } = await jobAt("inspected");
  await adminDb.insert(document).values({ tenantId, jobId, propertyId, kind: "photo", r2Key: "k" });
  await adminDb.insert(estimate).values({ tenantId, jobId, propertyId, status: "draft", lineItems: [] });
  const r = await withTenant(tenantId, (tx) => recordStageChange(tx, { tenantId, jobId, toStage: "estimate" }));
  expect(r.fromStage).toBe("inspected");
});

it("backward transition without a reason is REJECTED; with a reason it records the note", async () => {
  const { tenantId, jobId, propertyId } = await jobAt("estimate");
  await expect(withTenant(tenantId, (tx) => recordStageChange(tx, { tenantId, jobId, toStage: "lead" })))
    .rejects.toBeInstanceOf(BackwardNeedsReasonError);
  await withTenant(tenantId, (tx) => recordStageChange(tx, { tenantId, jobId, toStage: "lead", reason: "manual correction" }));
  const [ev] = await adminDb.select().from(jobStageEvent).where(eq(jobStageEvent.jobId, jobId)).orderBy(jobStageEvent.enteredAt);
  expect(ev!.note).toBe("manual correction");
});
