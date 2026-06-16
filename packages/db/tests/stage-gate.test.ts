import { describe, it, expect } from "vitest";
import { withTenant } from "../src/tenant.js";
import { recordStageChange, IncompletePhotosError } from "../src/lifecycle/record-stage-change.js";
import { document, jobStageEvent } from "../src/schema/index.js";
import { eq, and } from "drizzle-orm";
import { makeTenant, makeJobWithCustomer } from "./helpers.js";

async function makeTenantAndRetailJob(): Promise<{ tenantId: string; jobId: string }> {
  const { tenantId } = await makeTenant();
  const { jobId } = await makeJobWithCustomer(tenantId); // type defaults to "retail"
  return { tenantId, jobId };
}

describe("completion photo gate", () => {
  it("blocks ->complete when a required photo label is missing (writes no stage event)", async () => {
    const { tenantId, jobId } = await makeTenantAndRetailJob(); // no photos
    await expect(
      withTenant(tenantId, (tx) => recordStageChange(tx, { tenantId, jobId, toStage: "complete" })),
    ).rejects.toBeInstanceOf(IncompletePhotosError);
    const events = await withTenant(tenantId, (tx) =>
      tx.select().from(jobStageEvent).where(and(eq(jobStageEvent.jobId, jobId), eq(jobStageEvent.toStage, "complete"))));
    expect(events).toHaveLength(0);
  });

  it("allows ->complete once all required photo labels are present", async () => {
    const { tenantId, jobId } = await makeTenantAndRetailJob();
    // Insert photos in a SEPARATE withTenant call so they are committed before the gate checks
    await withTenant(tenantId, async (tx) => {
      for (const label of ["before", "after"]) {
        await tx.insert(document).values({ tenantId, jobId, kind: "photo", label, r2Key: `${tenantId}/${jobId}/${label}.jpg`, source: "savvy" });
      }
    });
    await withTenant(tenantId, (tx) => recordStageChange(tx, { tenantId, jobId, toStage: "complete" }));
    const events = await withTenant(tenantId, (tx) =>
      tx.select().from(jobStageEvent).where(and(eq(jobStageEvent.jobId, jobId), eq(jobStageEvent.toStage, "complete"))));
    expect(events).toHaveLength(1);
  });

  it("does not check photos for non-complete transitions", async () => {
    const { tenantId, jobId } = await makeTenantAndRetailJob();
    // Should succeed without any photos since it's not a ->complete transition
    await withTenant(tenantId, (tx) => recordStageChange(tx, { tenantId, jobId, toStage: "production" }));
  });
});
