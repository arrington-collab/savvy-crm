import { describe, it, expect } from "vitest";
import { withTenant } from "../src/tenant.js";
import { recordStageChange, StageEvidenceError } from "../src/lifecycle/record-stage-change.js";
import { document, jobStageEvent, estimate, appointment, invoice } from "../src/schema/index.js";
import { eq, and } from "drizzle-orm";
import { makeTenant, makeJobWithProperty } from "./helpers.js";

async function makeTenantAndRetailJob(): Promise<{ tenantId: string; jobId: string; propertyId: string }> {
  const { tenantId } = await makeTenant();
  const { jobId, propertyId } = await makeJobWithProperty(tenantId); // type defaults to "retail"
  return { tenantId, jobId, propertyId };
}

// Evidence-derived stage gate (Task 3) now runs BEFORE the completion photo
// gate, and the closeout-photo evidence key is the SAME missingProductionPhotos
// check the photo gate used — so a job missing photos is caught by the
// (broader) evidence gate rather than the old IncompletePhotosError. These
// tests seed the full contiguous evidence chain up through 'production' so the
// completion-photo behavior can still be exercised on its own.
async function seedChainThroughProduction(tenantId: string, jobId: string, propertyId: string): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.insert(document).values({ tenantId, jobId, propertyId, kind: "photo", r2Key: `${tenantId}/${jobId}/insp.jpg` });
    await tx.insert(estimate).values({ tenantId, jobId, propertyId, status: "accepted", lineItems: [] });
    await tx.insert(appointment).values({ tenantId, jobId, type: "crew", status: "scheduled", startsAt: new Date(), endsAt: new Date(Date.now() + 3_600_000) });
  });
}

describe("completion photo gate", () => {
  it("blocks ->complete when a required photo label is missing (writes no stage event)", async () => {
    const { tenantId, jobId, propertyId } = await makeTenantAndRetailJob(); // no closeout photos
    await seedChainThroughProduction(tenantId, jobId, propertyId);
    await expect(
      withTenant(tenantId, (tx) => recordStageChange(tx, { tenantId, jobId, toStage: "complete" })),
    ).rejects.toBeInstanceOf(StageEvidenceError);
    const events = await withTenant(tenantId, (tx) =>
      tx.select().from(jobStageEvent).where(and(eq(jobStageEvent.jobId, jobId), eq(jobStageEvent.toStage, "complete"))));
    expect(events).toHaveLength(0);
  });

  it("allows ->complete once all required photo labels are present", async () => {
    const { tenantId, jobId, propertyId } = await makeTenantAndRetailJob();
    await seedChainThroughProduction(tenantId, jobId, propertyId);
    // Insert closeout photos + a paid invoice in a SEPARATE withTenant call so they
    // are committed before the gate checks.
    await withTenant(tenantId, async (tx) => {
      for (const label of ["before", "after"]) {
        await tx.insert(document).values({ tenantId, jobId, propertyId, kind: "photo", label, r2Key: `${tenantId}/${jobId}/${label}.jpg`, source: "savvy" });
      }
      await tx.insert(invoice).values({ tenantId, jobId, status: "paid" });
    });
    await withTenant(tenantId, (tx) => recordStageChange(tx, { tenantId, jobId, toStage: "complete" }));
    const events = await withTenant(tenantId, (tx) =>
      tx.select().from(jobStageEvent).where(and(eq(jobStageEvent.jobId, jobId), eq(jobStageEvent.toStage, "complete"))));
    expect(events).toHaveLength(1);
  });

  it("does not check photos for non-complete transitions", async () => {
    const { tenantId, jobId, propertyId } = await makeTenantAndRetailJob();
    await seedChainThroughProduction(tenantId, jobId, propertyId);
    // Should succeed without any closeout photos since it's not a ->complete transition
    await withTenant(tenantId, (tx) => recordStageChange(tx, { tenantId, jobId, toStage: "production" }));
  });
});
