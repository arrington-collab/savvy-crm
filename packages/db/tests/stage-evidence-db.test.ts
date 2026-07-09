import { afterAll, expect, it } from "vitest";
import { withTenant } from "../src/tenant.js";
import { adminDb, adminPool, eq } from "../src/index.js";
import { tenant, job, estimate, document, appointment } from "../src/schema/index.js";
import { gatherStageEvidence } from "../src/lifecycle/stage-evidence-db.js";
import { makeTenant, makeJobWithProperty } from "./helpers.js";

const tids: string[] = [];
afterAll(async () => {
  for (const t of tids) await adminDb.delete(tenant).where(eq(tenant.id, t)).catch(() => {});
  await adminPool.end();
});

it("no evidence → all false", async () => {
  const { tenantId } = await makeTenant(); tids.push(tenantId);
  const { jobId } = await makeJobWithProperty(tenantId);
  const ev = await withTenant(tenantId, (tx) => gatherStageEvidence(tx, { tenantId, jobId }));
  expect(ev.inspection).toBe(false);
  expect(ev.estimate).toBe(false);
  expect(ev.approval).toBe(false);
});

it("a photo doc → inspection true; an estimate row → estimate true; an accepted estimate → approval true", async () => {
  const { tenantId } = await makeTenant(); tids.push(tenantId);
  const { jobId, propertyId } = await makeJobWithProperty(tenantId);
  await adminDb.insert(document).values({ tenantId, jobId, propertyId, kind: "photo", r2Key: "k" });
  await adminDb.insert(estimate).values({ tenantId, jobId, propertyId, status: "accepted", lineItems: [] });
  const ev = await withTenant(tenantId, (tx) => gatherStageEvidence(tx, { tenantId, jobId }));
  expect(ev.inspection).toBe(true);
  expect(ev.estimate).toBe(true);
  expect(ev.approval).toBe(true);
});

it("a done inspection appointment → inspection true", async () => {
  const { tenantId } = await makeTenant(); tids.push(tenantId);
  const { jobId, propertyId } = await makeJobWithProperty(tenantId);
  await adminDb.insert(appointment).values({ tenantId, jobId, propertyId, type: "inspection", status: "done", startsAt: new Date(), endsAt: new Date() });
  const ev = await withTenant(tenantId, (tx) => gatherStageEvidence(tx, { tenantId, jobId }));
  expect(ev.inspection).toBe(true);
});
