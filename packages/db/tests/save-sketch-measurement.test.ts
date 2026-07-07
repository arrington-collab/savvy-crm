import { describe, it, expect } from "vitest";
import type { RoofSketch } from "@savvy/core";
import { saveSketchMeasurement } from "../src/lifecycle/measurement.js";
import { draftLeadEstimateIfReady } from "../src/lifecycle/estimate.js";
import { ensurePriceBook } from "../src/lifecycle/price-book.js";
import { adminDb, appointment, measurement, estimate, customer, lead, eq } from "../src/index.js";
import { makeTenant, makeLeadWithProperty, makeJobWithProperty } from "./helpers.js";

/** A minimal but valid DIY sketch: one 20×20ft facet at 6/12. */
function makeSketch(pitch = "6/12"): RoofSketch {
  return {
    version: 1,
    centerLat: 33.4,
    centerLng: -112.0,
    zoom: 20,
    calibration: 1,
    facets: [
      {
        id: "facet-1",
        points: [
          { x: 0, y: 0 },
          { x: 20, y: 0 },
          { x: 20, y: 20 },
          { x: 0, y: 20 },
        ],
        pitch,
        edges: ["eave", "rake", "ridge", "rake"],
        label: "none",
      },
    ],
  };
}

async function completeInspection(tenantId: string, leadId: string, propertyId: string): Promise<void> {
  await adminDb.insert(appointment).values({
    tenantId, leadId, propertyId, type: "inspection", status: "done",
    startsAt: new Date(Date.now() - 7200_000), endsAt: new Date(Date.now() - 3600_000),
  });
}

/**
 * Slice: the roof drawing (DIY sketch) is creatable at LEAD stage — before any job
 * exists. `measurement` is property-scoped, so a lead-stage sketch is the same row the
 * job later reads. The lifecycle fn resolves the property from a lead OR a job scope.
 */
describe("saveSketchMeasurement", () => {
  it("creates a DIY sketch measurement on the lead's property for a lead with no job", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId } = await makeLeadWithProperty(tenantId);

    const res = await saveSketchMeasurement({ tenantId, scope: { kind: "lead", id: leadId }, sketch: makeSketch() });
    expect("ok" in res).toBe(true);
    if (!("ok" in res)) throw new Error(res.error);

    // leadId set, jobId omitted — the estimate gate keys off leadId.
    expect(res.propertyId).toBe(propertyId);
    expect(res.leadId).toBe(leadId);
    expect(res.jobId).toBeUndefined();

    const [m] = await adminDb.select().from(measurement).where(eq(measurement.id, res.measurementId));
    expect(m!.propertyId).toBe(propertyId);
    expect(m!.provider).toBe("diy");
    expect(m!.source).toBe("sketch");
    expect(m!.pitch).toBe("6/12");
    // Sketch geometry rides along in areas so the editor can re-open it.
    expect((m!.areas as { sketch?: unknown }).sketch).toBeTruthy();
  });

  it("lets the estimate gate draft a lead-scoped estimate once the inspection is complete (no job)", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId } = await makeLeadWithProperty(tenantId);
    await ensurePriceBook(tenantId);
    await completeInspection(tenantId, leadId, propertyId);

    await saveSketchMeasurement({ tenantId, scope: { kind: "lead", id: leadId }, sketch: makeSketch() });

    const res = await draftLeadEstimateIfReady({ tenantId, leadId });
    expect("estimateId" in res).toBe(true);
    const [e] = await adminDb.select().from(estimate).where(eq(estimate.id, (res as { estimateId: string }).estimateId));
    expect(e!.leadId).toBe(leadId);
    expect(e!.jobId).toBeNull();
    expect(e!.status).toBe("draft");
  });

  it("returns { error: 'no_property' } when the lead has no property yet", async () => {
    const { tenantId } = await makeTenant();
    const [c] = await adminDb.insert(customer).values({ tenantId, name: "No Property" }).returning();
    const [l] = await adminDb.insert(lead).values({ tenantId, customerId: c!.id, source: "test" }).returning();

    const res = await saveSketchMeasurement({ tenantId, scope: { kind: "lead", id: l!.id }, sketch: makeSketch() });
    expect(res).toEqual({ error: "no_property" });
  });

  it("returns { error: 'invalid_sketch' } for a malformed sketch", async () => {
    const { tenantId } = await makeTenant();
    const { leadId } = await makeLeadWithProperty(tenantId);
    const bad = { ...makeSketch(), facets: [{ ...makeSketch().facets[0]!, points: [{ x: 0, y: 0 }] }] };

    const res = await saveSketchMeasurement({ tenantId, scope: { kind: "lead", id: leadId }, sketch: bad as unknown as RoofSketch });
    expect(res).toEqual({ error: "invalid_sketch" });
  });

  it("regression: job scope still creates a DIY measurement on the job's property", async () => {
    const { tenantId } = await makeTenant();
    const { jobId, propertyId } = await makeJobWithProperty(tenantId);

    const res = await saveSketchMeasurement({ tenantId, scope: { kind: "job", id: jobId }, sketch: makeSketch() });
    expect("ok" in res).toBe(true);
    if (!("ok" in res)) throw new Error(res.error);

    expect(res.propertyId).toBe(propertyId);
    expect(res.jobId).toBe(jobId);
    expect(res.leadId).toBeUndefined();

    const [m] = await adminDb.select().from(measurement).where(eq(measurement.id, res.measurementId));
    expect(m!.provider).toBe("diy");
    expect(m!.source).toBe("sketch");
  });

  it("updates the existing measurement row when a measurementId is supplied (no duplicate)", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId } = await makeLeadWithProperty(tenantId);

    const first = await saveSketchMeasurement({ tenantId, scope: { kind: "lead", id: leadId }, sketch: makeSketch("6/12") });
    if (!("ok" in first)) throw new Error(first.error);

    const second = await saveSketchMeasurement({
      tenantId,
      scope: { kind: "lead", id: leadId },
      sketch: makeSketch("8/12"),
      measurementId: first.measurementId,
    });
    if (!("ok" in second)) throw new Error(second.error);
    expect(second.measurementId).toBe(first.measurementId);

    const rows = await adminDb.select().from(measurement).where(eq(measurement.propertyId, propertyId));
    expect(rows.length).toBe(1);
    expect(rows[0]!.pitch).toBe("8/12");
  });
});
