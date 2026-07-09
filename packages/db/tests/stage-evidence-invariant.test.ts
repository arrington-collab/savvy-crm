import { afterAll, expect, it } from "vitest";
import { evidenceChecks, type EvidenceCtx } from "@savvy/core";
import { adminDb, adminPool, eq } from "../src/index.js";
import { tenant, job, document } from "../src/schema/index.js";
import { makeTenant, makeJobWithProperty } from "./helpers.js";

const WINDOW = { start: new Date(Date.now() - 86_400_000), end: new Date(Date.now() + 86_400_000) };
const tids: string[] = [];
afterAll(async () => { for (const t of tids) await adminDb.delete(tenant).where(eq(tenant.id, t)).catch(() => {}); await adminPool.end(); });
const run = (tenantId: string) => evidenceChecks["job.stage_evidence"]!({ tenantId, db: adminPool, params: {}, window: WINDOW } as EvidenceCtx);

it("passes when a job's current stage has its own evidence", async () => {
  const { tenantId } = await makeTenant(); tids.push(tenantId);
  const { jobId, propertyId } = await makeJobWithProperty(tenantId);
  await adminDb.insert(document).values({ tenantId, jobId, propertyId, kind: "photo", r2Key: "k" });
  await adminDb.update(job).set({ stage: "inspected" }).where(eq(job.id, jobId));
  const r = await run(tenantId);
  expect(r.status).toBe("pass");
});

it("fails for a job declared past its evidence (inspected, no inspection) — RED PATH", async () => {
  const { tenantId } = await makeTenant(); tids.push(tenantId);
  const { jobId } = await makeJobWithProperty(tenantId);
  await adminDb.update(job).set({ stage: "inspected" }).where(eq(job.id, jobId));
  const r = await run(tenantId);
  expect(r.status).toBe("fail");
  expect(r.refs.length).toBeGreaterThanOrEqual(1);
});
