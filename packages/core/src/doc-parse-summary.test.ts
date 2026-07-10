import { describe, expect, it } from "vitest";
import { parseSummaryView, type DocParseSummary } from "./doc-parse-summary";

describe("parseSummaryView", () => {
  it("insurance parsed → carrier/claim/money rows + claim link to its job when converted", () => {
    const s: DocParseSummary = {
      kind: "insurance_estimate", status: "parsed", confidence: 0.91,
      claim: { id: "c1", jobId: "j1", carrierName: "Acme", claimNumber: "CLM-9", acvCents: 100000, rcvCents: 150000, deductibleCents: 100000, lineItemCount: 12 },
    };
    const v = parseSummaryView(s);
    expect(v.tone).toBe("parsed");
    expect(v.entityLink).toEqual({ kind: "claim", jobId: "j1" });
    expect(v.rows).toContainEqual({ label: "Carrier", value: "Acme" });
    expect(v.rows).toContainEqual({ label: "Line items", value: "12" });
    expect(v.rows).toContainEqual({ label: "RCV", value: "$1,500" });
  });

  it("insurance parsed but lead not yet converted → claim link carries no job (jobId null)", () => {
    const s: DocParseSummary = {
      kind: "insurance_estimate", status: "parsed", confidence: 0.9,
      claim: { id: "c1", jobId: null, carrierName: "Acme", claimNumber: "CLM-9", acvCents: null, rcvCents: null, deductibleCents: null, lineItemCount: 3 },
    };
    expect(parseSummaryView(s).entityLink).toEqual({ kind: "claim", jobId: null });
  });

  it("low-confidence → 'Stored, unparsed — card open', no rows, no link (RED PATH #2)", () => {
    const s: DocParseSummary = { kind: "insurance_estimate", status: "unparsed_low_confidence", confidence: 0.42, claim: null };
    const v = parseSummaryView(s);
    expect(v.tone).toBe("low");
    expect(v.headline).toBe("Stored, unparsed — card open");
    expect(v.rows).toEqual([]);
    expect(v.entityLink).toBeNull();
  });

  it("measurement parsed → squares/pitch/LF rows + measurement link; NO waste row when absent", () => {
    const s: DocParseSummary = {
      kind: "measurement_report", status: "parsed", confidence: 0.88,
      measurement: { id: "m1", squares: 24, pitch: "8/12", ridgeLf: 40, hipLf: 10, valleyLf: 12, eaveLf: 120, rakeLf: 60, facetCount: 6, penetrationCount: 3, wasteFactor: null },
    };
    const v = parseSummaryView(s);
    expect(v.tone).toBe("parsed");
    expect(v.entityLink).toEqual({ kind: "measurement", id: "m1" });
    expect(v.rows).toContainEqual({ label: "Squares", value: "24" });
    expect(v.rows).toContainEqual({ label: "Pitch", value: "8/12" });
    expect(v.rows.some((r) => /waste/i.test(r.label))).toBe(false);
  });

  it("measurement parsed WITH a waste factor present → shows a Waste row as a percentage", () => {
    const s: DocParseSummary = {
      kind: "measurement_report", status: "parsed", confidence: 0.9,
      measurement: { id: "m2", squares: 24, pitch: "6/12", ridgeLf: null, hipLf: null, valleyLf: null, eaveLf: null, rakeLf: null, facetCount: null, penetrationCount: null, wasteFactor: 0.15 },
    };
    expect(parseSummaryView(s).rows).toContainEqual({ label: "Waste", value: "15%" });
  });

  it("parse_failed and pending map to their tones with no rows", () => {
    expect(parseSummaryView({ kind: "insurance_estimate", status: "parse_failed", confidence: null, claim: null }).tone).toBe("failed");
    expect(parseSummaryView({ kind: "measurement_report", status: "pending", confidence: null, measurement: null }).tone).toBe("pending");
  });
});
