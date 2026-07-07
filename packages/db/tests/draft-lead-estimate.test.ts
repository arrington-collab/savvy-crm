import { describe, it, expect } from "vitest";
import { draftLeadEstimateIfReady } from "../src/lifecycle/estimate.js";
import { ensurePriceBook } from "../src/lifecycle/price-book.js";
import { withTenant } from "../src/tenant.js";
import { adminDb, appointment, measurement, estimate, eq, and } from "../src/index.js";
import { makeTenant, makeLeadWithProperty } from "./helpers.js";

async function completeInspection(tenantId: string, leadId: string, propertyId: string): Promise<void> {
  await adminDb.insert(appointment).values({
    tenantId, leadId, propertyId, type: "inspection", status: "done",
    startsAt: new Date(Date.now() - 7200_000), endsAt: new Date(Date.now() - 3600_000),
  });
}

async function landMeasurement(tenantId: string, propertyId: string): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx.insert(measurement).values({
      tenantId, propertyId, provider: "roofr",
      areas: { squares: 20, predominantPitch: "8/12", eaveLf: 100, rakeLf: 50 },
    }),
  );
}

/**
 * Slice 1 estimate trigger: a draft is generated once the inspection is complete
 * AND a measurement (Roofr or DIY — first data wins) has landed. Draft-once.
 */
describe("draftLeadEstimateIfReady", () => {
  it("skips when the inspection is not yet complete (measurement present)", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId } = await makeLeadWithProperty(tenantId);
    await ensurePriceBook(tenantId);
    await landMeasurement(tenantId, propertyId);

    const res = await draftLeadEstimateIfReady({ tenantId, leadId });
    expect(res).toEqual({ skipped: "inspection_not_complete" });
  });

  it("skips when no measurement has landed (inspection complete)", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId } = await makeLeadWithProperty(tenantId);
    await ensurePriceBook(tenantId);
    await completeInspection(tenantId, leadId, propertyId);

    const res = await draftLeadEstimateIfReady({ tenantId, leadId });
    expect(res).toEqual({ skipped: "no_measurement" });
  });

  it("drafts a lead-scoped estimate once both the inspection is done and a measurement landed", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId } = await makeLeadWithProperty(tenantId);
    await ensurePriceBook(tenantId);
    await completeInspection(tenantId, leadId, propertyId);
    await landMeasurement(tenantId, propertyId);

    const res = await draftLeadEstimateIfReady({ tenantId, leadId });
    expect("estimateId" in res).toBe(true);
    const [e] = await adminDb.select().from(estimate).where(eq(estimate.id, (res as { estimateId: string }).estimateId));
    expect(e!.leadId).toBe(leadId);
    expect(e!.jobId).toBeNull();
    expect(e!.status).toBe("draft");

    // Draft-once: a second trigger does not create a duplicate.
    const again = await draftLeadEstimateIfReady({ tenantId, leadId });
    expect(again).toEqual({ skipped: "estimate_exists" });
  });

  it("drafts from the ORDERED measurement even when a newer sketch exists (precedence)", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId } = await makeLeadWithProperty(tenantId);
    await ensurePriceBook(tenantId);
    await completeInspection(tenantId, leadId, propertyId);
    // Older ordered measurement, then a NEWER sketch — precedence must pick ordered.
    await withTenant(tenantId, (tx) => tx.insert(measurement).values({
      tenantId, propertyId, provider: "roofr", source: "ordered",
      areas: { squares: 20, predominantPitch: "6/12", eaveLf: 100, rakeLf: 50 },
    }));
    await withTenant(tenantId, (tx) => tx.insert(measurement).values({
      tenantId, propertyId, provider: "diy", source: "sketch",
      areas: { squares: 99, predominantPitch: "4/12" },
    }));

    const res = await draftLeadEstimateIfReady({ tenantId, leadId });
    expect("estimateId" in res).toBe(true);
    const [e] = await adminDb.select().from(estimate).where(eq(estimate.id, (res as { estimateId: string }).estimateId));
    const [orderedM] = await adminDb.select().from(measurement)
      .where(and(eq(measurement.propertyId, propertyId), eq(measurement.source, "ordered")));
    expect(e!.measurementId).toBe(orderedM!.id);
  });
});
