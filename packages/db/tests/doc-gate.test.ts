import { describe, it, expect } from "vitest";
import { withTenant } from "../src/tenant.js";
import { recordStageChange, IncompleteDocumentsError } from "../src/lifecycle/record-stage-change.js";
import { document, estimate, appointment, jobStageEvent, tenant } from "../src/schema/index.js";
import { adminDb } from "../src/admin-client.js";
import { eq, and } from "drizzle-orm";
import { makeTenant, makeJobWithCustomer } from "./helpers.js";

/** Tenant whose production config requires a `contract` doc to enter `production`. */
async function makeGatedTenantAndJob(): Promise<{ tenantId: string; jobId: string }> {
  const { tenantId } = await makeTenant();
  await adminDb.update(tenant)
    .set({ settings: { production: { requiredDocs: { production: ["contract"] } } } })
    .where(eq(tenant.id, tenantId));
  const { jobId } = await makeJobWithCustomer(tenantId); // type defaults to "retail"
  return { tenantId, jobId };
}

/** Seeds inspection + estimate + approval evidence (own-stage chain up to 'approved'). */
async function seedThroughApproved(tenantId: string, jobId: string): Promise<void> {
  await adminDb.insert(document).values({ tenantId, jobId, kind: "photo", r2Key: `${tenantId}/${jobId}/insp.jpg` });
  await adminDb.insert(estimate).values({ tenantId, jobId, status: "accepted", lineItems: [] });
}

/** Seeds inspection + estimate + approval + production evidence (chain up to 'production'). */
async function seedThroughProduction(tenantId: string, jobId: string): Promise<void> {
  await seedThroughApproved(tenantId, jobId);
  const now = new Date();
  await adminDb.insert(appointment).values({
    tenantId, jobId, type: "crew", status: "scheduled",
    startsAt: now, endsAt: new Date(now.getTime() + 3600_000),
  });
}

describe("document gate (per-stage)", () => {
  it("blocks ->production when a required doc kind is missing (writes no stage event)", async () => {
    const { tenantId, jobId } = await makeGatedTenantAndJob(); // no contract doc, but evidence chain seeded
    await seedThroughProduction(tenantId, jobId);
    const err = await withTenant(tenantId, (tx) => recordStageChange(tx, { tenantId, jobId, toStage: "production" }))
      .then(() => null, (e) => e);
    expect(err).toBeInstanceOf(IncompleteDocumentsError);
    expect((err as IncompleteDocumentsError).missing).toContain("contract");
    const events = await withTenant(tenantId, (tx) =>
      tx.select().from(jobStageEvent).where(and(eq(jobStageEvent.jobId, jobId), eq(jobStageEvent.toStage, "production"))));
    expect(events).toHaveLength(0);
  });

  it("allows ->production once a document of the required kind is present", async () => {
    const { tenantId, jobId } = await makeGatedTenantAndJob();
    await seedThroughProduction(tenantId, jobId);
    await withTenant(tenantId, async (tx) => {
      await tx.insert(document).values({ tenantId, jobId, kind: "contract", label: "signed", r2Key: `${tenantId}/${jobId}/c.pdf`, source: "docuseal" });
    });
    await withTenant(tenantId, (tx) => recordStageChange(tx, { tenantId, jobId, toStage: "production" }));
    const events = await withTenant(tenantId, (tx) =>
      tx.select().from(jobStageEvent).where(and(eq(jobStageEvent.jobId, jobId), eq(jobStageEvent.toStage, "production"))));
    expect(events).toHaveLength(1);
  });

  it("does not gate a stage with no configured docs", async () => {
    const { tenantId, jobId } = await makeGatedTenantAndJob(); // only `production` is gated
    await seedThroughApproved(tenantId, jobId);
    await withTenant(tenantId, (tx) => recordStageChange(tx, { tenantId, jobId, toStage: "approved" }));
    const events = await withTenant(tenantId, (tx) =>
      tx.select().from(jobStageEvent).where(and(eq(jobStageEvent.jobId, jobId), eq(jobStageEvent.toStage, "approved"))));
    expect(events).toHaveLength(1);
  });
});
