import { describe, it, expect } from "vitest";
import { createEstimateFromMeasurement } from "../src/lifecycle/estimate.js";
import { ensurePriceBook } from "../src/lifecycle/price-book.js";
import { withTenant } from "../src/tenant.js";
import { measurement } from "../src/schema/ops.js";
import { makeTenant, makeLeadWithProperty } from "./helpers.js";

/**
 * Slice 1 — the architectural decision: measurement + estimate are LEAD/PROPERTY
 * artifacts. An estimate can be drafted before any job exists, scoped to the lead
 * and property. `job_id` is only stamped later, when the accepted estimate creates
 * the job.
 */
describe("createEstimateFromMeasurement — lead/property scoped", () => {
  it("creates a draft estimate scoped to a lead with job_id null", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId } = await makeLeadWithProperty(tenantId);
    await ensurePriceBook(tenantId);

    const measurementId = await withTenant(tenantId, async (tx) => {
      const [m] = await tx
        .insert(measurement)
        .values({
          tenantId,
          propertyId,
          provider: "roofr",
          areas: { squares: 20, predominantPitch: "8/12", eaveLf: 100, rakeLf: 50 },
        })
        .returning();
      return m!.id;
    });

    const est = await createEstimateFromMeasurement({ tenantId, measurementId, leadId });

    expect(est?.status).toBe("draft");
    expect(est?.source).toBe("roofr");
    expect((est?.total ?? 0)).toBeGreaterThan(0);
    // The heart of the overhaul: no job exists yet.
    expect(est?.jobId).toBeNull();
    expect(est?.leadId).toBe(leadId);
    expect(est?.propertyId).toBe(propertyId);
  });
});
