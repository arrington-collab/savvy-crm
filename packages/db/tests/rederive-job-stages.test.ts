import { afterAll, expect, it } from "vitest";
import { adminDb, adminPool, eq } from "../src/index.js";
import { tenant, job } from "../src/schema/index.js";
import { rederiveJobStages } from "../src/scripts/rederive-job-stages.js";
import { makeTenant, makeJobWithProperty } from "./helpers.js";

const tids: string[] = [];
afterAll(async () => { for (const t of tids) await adminDb.delete(tenant).where(eq(tenant.id, t)).catch(() => {}); await adminPool.end(); });

it("regresses an over-declared job (inspected, no evidence) to lead; idempotent", { timeout: 120_000 }, async () => {
  const { tenantId } = await makeTenant(); tids.push(tenantId);
  const { jobId } = await makeJobWithProperty(tenantId);
  await adminDb.update(job).set({ stage: "inspected" }).where(eq(job.id, jobId)); // Josh: declared, no evidence

  const dry = await rederiveJobStages({ dryRun: true });
  expect(dry.changes.find((c) => c.jobId === jobId)).toMatchObject({ from: "inspected", to: "lead" });
  const [before] = await adminDb.select({ stage: job.stage }).from(job).where(eq(job.id, jobId));
  expect(before!.stage).toBe("inspected"); // dry-run wrote nothing

  await rederiveJobStages({ dryRun: false });
  const [after] = await adminDb.select({ stage: job.stage }).from(job).where(eq(job.id, jobId));
  expect(after!.stage).toBe("lead");

  const again = await rederiveJobStages({ dryRun: false });
  expect(again.changes.find((c) => c.jobId === jobId)).toBeUndefined(); // idempotent
});
