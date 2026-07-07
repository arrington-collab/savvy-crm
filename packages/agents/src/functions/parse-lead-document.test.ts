import { describe, it, expect, vi } from "vitest";
import { parseLeadDocumentHandler, type ParseLeadDocumentDeps } from "./parse-lead-document";
import type { MeasurementReportParse } from "@savvy/core";

function makeDeps(over: Partial<ParseLeadDocumentDeps> = {}): ParseLeadDocumentDeps {
  const parsed: MeasurementReportParse = {
    squares: 20, predominantPitch: "8/12", ridgeLf: 0, hipLf: 0, valleyLf: 0,
    eaveLf: 100, rakeLf: 50, stepFlashingLf: 0, penetrationCount: 0, facetCount: 0, confidence: 0.95,
  };
  return {
    loadDoc: vi.fn().mockResolvedValue({ r2Key: "t/lead/l/m.pdf", kind: "measurement_report", leadId: "l1", propertyId: "p1" }),
    fetchBytes: vi.fn().mockResolvedValue(new Uint8Array([1])),
    ai: { completeObject: vi.fn().mockResolvedValue({ object: parsed, model: "stub" }) },
    insertMeasurement: vi.fn().mockResolvedValue("m1"),
    setStatus: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

describe("parseLeadDocumentHandler", () => {
  it("parses a measurement_report → inserts measurement, sets parsed, returns ids", async () => {
    const deps = makeDeps();
    const res = await parseLeadDocumentHandler({ tenantId: "t1", documentId: "d1" }, deps);
    expect(res).toEqual({ status: "parsed", measurementId: "m1", leadId: "l1", propertyId: "p1" });
    expect(deps.insertMeasurement).toHaveBeenCalledOnce();
    expect(deps.setStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "parsed", confidence: 0.95 }));
  });

  it("cards a low-confidence parse without inserting a measurement", async () => {
    const low: MeasurementReportParse = { squares: 1, predominantPitch: "0/12", ridgeLf: 0, hipLf: 0, valleyLf: 0, eaveLf: 0, rakeLf: 0, stepFlashingLf: 0, penetrationCount: 0, facetCount: 0, confidence: 0.4 };
    const deps = makeDeps({ ai: { completeObject: vi.fn().mockResolvedValue({ object: low, model: "stub" }) } });
    const res = await parseLeadDocumentHandler({ tenantId: "t1", documentId: "d1" }, deps);
    expect(res.status).toBe("unparsed_low_confidence");
    expect(deps.insertMeasurement).not.toHaveBeenCalled();
    expect(deps.setStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "unparsed_low_confidence" }));
  });

  it("skips a non-measurement kind (insurance_estimate is 6c)", async () => {
    const deps = makeDeps({ loadDoc: vi.fn().mockResolvedValue({ r2Key: "k", kind: "insurance_estimate", leadId: "l1", propertyId: "p1" }) });
    const res = await parseLeadDocumentHandler({ tenantId: "t1", documentId: "d1" }, deps);
    expect(res.status).toBe("skipped");
    expect(deps.ai.completeObject).not.toHaveBeenCalled();
  });

  it("fail-soft: an AI/throw sets parse_failed and never throws", async () => {
    const deps = makeDeps({ ai: { completeObject: vi.fn().mockRejectedValue(new Error("boom")) } });
    const res = await parseLeadDocumentHandler({ tenantId: "t1", documentId: "d1" }, deps);
    expect(res.status).toBe("parse_failed");
    expect(deps.setStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "parse_failed" }));
  });
});
