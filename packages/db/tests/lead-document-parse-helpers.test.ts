import { describe, it, expect } from "vitest";
import {
  recordLeadDocument, getLeadDocumentForParse, upsertUploadedMeasurement, setDocumentParseStatus,
} from "../src/lifecycle/lead-documents.js";
import { adminDb, document, measurement, eq, and } from "../src/index.js";
import { makeTenant, makeLeadWithProperty } from "./helpers.js";

describe("lead-document parse DB helpers", () => {
  it("getLeadDocumentForParse returns the doc's key, kind, lead and property", async () => {
    const { tenantId } = await makeTenant();
    const { leadId, propertyId } = await makeLeadWithProperty(tenantId);
    const rec = await recordLeadDocument({
      tenantId, leadId, uploadedByUserId: null,
      r2Key: `${tenantId}/lead/${leadId}/m.pdf`, kind: "measurement_report",
      filename: "m.pdf", mime: "application/pdf", sizeBytes: 10,
    });
    const got = await getLeadDocumentForParse(tenantId, rec!.id);
    expect(got).toMatchObject({ r2Key: `${tenantId}/lead/${leadId}/m.pdf`, kind: "measurement_report", leadId, propertyId });
  });

  it("upsertUploadedMeasurement creates a uploaded_report measurement", async () => {
    const { tenantId } = await makeTenant();
    const { propertyId } = await makeLeadWithProperty(tenantId);
    const mid = await upsertUploadedMeasurement({
      tenantId, propertyId, areas: { squares: 21, predominantPitch: "7/12" }, pitch: "7/12",
    });
    const [m] = await adminDb.select().from(measurement).where(eq(measurement.id, mid));
    expect(m!.source).toBe("uploaded_report");
    expect(m!.provider).toBe("roofr");
    expect((m!.areas as { squares?: number }).squares).toBe(21);
  });

  it("upsertUploadedMeasurement is idempotent: re-parse updates one row, id stable", async () => {
    const { tenantId } = await makeTenant();
    const { propertyId } = await makeLeadWithProperty(tenantId);
    const first = await upsertUploadedMeasurement({
      tenantId, propertyId, areas: { squares: 20, predominantPitch: "6/12" }, pitch: "6/12",
    });
    const second = await upsertUploadedMeasurement({
      tenantId, propertyId, areas: { squares: 24, predominantPitch: "8/12" }, pitch: "8/12",
    });
    expect(second).toBe(first); // same row updated, not a new insert
    const rows = await adminDb.select().from(measurement)
      .where(and(eq(measurement.propertyId, propertyId), eq(measurement.source, "uploaded_report")));
    expect(rows).toHaveLength(1);
    expect((rows[0]!.areas as { squares: number }).squares).toBe(24);
    expect(rows[0]!.pitch).toBe("8/12");
  });

  it("setDocumentParseStatus updates status + confidence", async () => {
    const { tenantId } = await makeTenant();
    const { leadId } = await makeLeadWithProperty(tenantId);
    const rec = await recordLeadDocument({
      tenantId, leadId, uploadedByUserId: null,
      r2Key: `${tenantId}/lead/${leadId}/m.pdf`, kind: "measurement_report",
      filename: "m.pdf", mime: "application/pdf", sizeBytes: 10,
    });
    await setDocumentParseStatus({ tenantId, documentId: rec!.id, status: "parsed", confidence: 0.9 });
    const [d] = await adminDb.select().from(document).where(eq(document.id, rec!.id));
    expect(d!.parseStatus).toBe("parsed");
    expect(d!.parseConfidence).toBeCloseTo(0.9);
  });
});
