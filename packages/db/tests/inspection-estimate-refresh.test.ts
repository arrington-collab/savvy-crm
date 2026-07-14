import { describe, it, expect } from "vitest";
import { refreshLeadEstimateDraft } from "../src/lifecycle/estimate.js";
import { startInspectionForLead, completeInspection } from "../src/lifecycle/inspection.js";
import { ensurePriceBook } from "../src/lifecycle/price-book.js";
import { withTenant } from "../src/tenant.js";
import { adminDb, measurement, estimate, eq } from "../src/index.js";
import { makeTenant, makeLeadWithProperty } from "./helpers.js";

async function landMeasurement(tenantId: string, propertyId: string, squares = 20): Promise<string> {
  return withTenant(tenantId, async (tx) => {
    const [m] = await tx.insert(measurement).values({
      tenantId, propertyId, provider: "roofr",
      areas: { squares, predominantPitch: "8/12", eaveLf: 100, rakeLf: 50 },
    }).returning();
    return m!.id;
  });
}

/**
 * Roof Record slice 1: the estimate PRE-DRAFT builds live during the inspection —
 * refresh is allowed while a roof-record inspection is in_progress; the final
 * draft locks on completion per the existing draft-once rules. Refresh never
 * touches an estimate that has left draft status.
 */
describe("refreshLeadEstimateDraft", () => {
  it("creates the pre-draft while the inspection is in_progress (no done appointment required)", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId } = await makeLeadWithProperty(tenantId);
    await ensurePriceBook(tenantId);
    await landMeasurement(tenantId, propertyId);
    await startInspectionForLead({ tenantId, leadId });

    const res = await refreshLeadEstimateDraft({ tenantId, leadId });
    expect("estimateId" in res && res.action === "created").toBe(true);

    const [e] = await adminDb.select().from(estimate).where(eq(estimate.id, (res as { estimateId: string }).estimateId));
    expect(e!.status).toBe("draft");
    expect(e!.leadId).toBe(leadId);
  });

  it("refreshes the existing draft when condition inputs change (new preferred measurement)", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId } = await makeLeadWithProperty(tenantId);
    await ensurePriceBook(tenantId);
    await landMeasurement(tenantId, propertyId, 20);
    await startInspectionForLead({ tenantId, leadId });

    const first = await refreshLeadEstimateDraft({ tenantId, leadId });
    const estimateId = (first as { estimateId: string }).estimateId;
    const [before] = await adminDb.select().from(estimate).where(eq(estimate.id, estimateId));

    // A bigger roof lands (e.g. the inspector re-measures) — same source, newer row wins.
    const biggerMeasurementId = await landMeasurement(tenantId, propertyId, 40);
    const second = await refreshLeadEstimateDraft({ tenantId, leadId });
    expect("estimateId" in second && second.action === "refreshed").toBe(true);
    expect((second as { estimateId: string }).estimateId).toBe(estimateId); // same draft, updated in place

    const [after] = await adminDb.select().from(estimate).where(eq(estimate.id, estimateId));
    expect(after!.measurementId).toBe(biggerMeasurementId);
    expect(after!.total).toBeGreaterThan(before!.total!);
  });

  it("skips when the lead has no in_progress roof-record inspection", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId } = await makeLeadWithProperty(tenantId);
    await ensurePriceBook(tenantId);
    await landMeasurement(tenantId, propertyId);

    const res = await refreshLeadEstimateDraft({ tenantId, leadId });
    expect(res).toEqual({ skipped: "no_active_inspection" });
  });

  it("skips when no measurement has landed yet", async () => {
    const { tenantId } = await makeTenant();
    const { leadId } = await makeLeadWithProperty(tenantId);
    await ensurePriceBook(tenantId);
    await startInspectionForLead({ tenantId, leadId });

    const res = await refreshLeadEstimateDraft({ tenantId, leadId });
    expect(res).toEqual({ skipped: "no_measurement" });
  });

  it("still re-prices during pending_approval (the final pass after the inspector climbs down)", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId } = await makeLeadWithProperty(tenantId);
    await ensurePriceBook(tenantId);
    await landMeasurement(tenantId, propertyId, 20);
    const started = await startInspectionForLead({ tenantId, leadId });
    await refreshLeadEstimateDraft({ tenantId, leadId });

    await completeInspection({ tenantId, inspectionId: (started as { inspectionId: string }).inspectionId });
    await landMeasurement(tenantId, propertyId, 40); // late-landing final measurement
    const res = await refreshLeadEstimateDraft({ tenantId, leadId });
    expect("estimateId" in res && res.action === "refreshed").toBe(true);
  });

  it("never touches an estimate that has left draft (the lock)", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId } = await makeLeadWithProperty(tenantId);
    await ensurePriceBook(tenantId);
    await landMeasurement(tenantId, propertyId, 20);
    await startInspectionForLead({ tenantId, leadId });

    const first = await refreshLeadEstimateDraft({ tenantId, leadId });
    const estimateId = (first as { estimateId: string }).estimateId;
    await adminDb.update(estimate).set({ status: "sent" }).where(eq(estimate.id, estimateId));

    await landMeasurement(tenantId, propertyId, 40);
    const res = await refreshLeadEstimateDraft({ tenantId, leadId });
    expect(res).toEqual({ skipped: "estimate_locked" });

    const [after] = await adminDb.select().from(estimate).where(eq(estimate.id, estimateId));
    expect(after!.status).toBe("sent");
  });
});
