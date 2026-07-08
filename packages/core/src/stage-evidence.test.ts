import { describe, expect, it } from "vitest";
import { deriveContiguousStage, missingEvidenceFor, stageEvidenceSatisfied, type StageEvidence } from "./stage-evidence";

const NONE: StageEvidence = { inspection: false, estimate: false, approval: false, production: false, closeoutPhotos: false, invoice: false, invoicePaid: false };
const ev = (p: Partial<StageEvidence>): StageEvidence => ({ ...NONE, ...p });

describe("deriveContiguousStage", () => {
  it("no evidence → lead (the Josh case)", () => {
    expect(deriveContiguousStage(NONE)).toBe("lead");
  });
  it("inspection only → inspected", () => {
    expect(deriveContiguousStage(ev({ inspection: true }))).toBe("inspected");
  });
  it("funnel chain (inspection+estimate+approval) → approved", () => {
    expect(deriveContiguousStage(ev({ inspection: true, estimate: true, approval: true }))).toBe("approved");
  });
  it("is contiguous — approval without inspection → lead (gap at inspection)", () => {
    expect(deriveContiguousStage(ev({ approval: true }))).toBe("lead");
  });
  it("full chain to billing", () => {
    expect(deriveContiguousStage(ev({ inspection: true, estimate: true, approval: true, production: true, closeoutPhotos: true, invoice: true }))).toBe("billing");
  });
});

describe("missingEvidenceFor", () => {
  it("names the first missing gate up to the target", () => {
    expect(missingEvidenceFor("approved", NONE)).toBe("inspection");
    expect(missingEvidenceFor("approved", ev({ inspection: true }))).toBe("estimate");
    expect(missingEvidenceFor("approved", ev({ inspection: true, estimate: true }))).toBe("approval");
    expect(missingEvidenceFor("approved", ev({ inspection: true, estimate: true, approval: true }))).toBeNull();
  });
  it("lead/lost have no gate", () => {
    expect(missingEvidenceFor("lead", NONE)).toBeNull();
    expect(missingEvidenceFor("lost", NONE)).toBeNull();
  });
});

describe("stageEvidenceSatisfied (own-stage, for the exception vector)", () => {
  it("inspected requires inspection; independent of other gates", () => {
    expect(stageEvidenceSatisfied("inspected", NONE)).toBe(false);
    expect(stageEvidenceSatisfied("inspected", ev({ inspection: true }))).toBe(true);
  });
  it("lead/lost always satisfied", () => {
    expect(stageEvidenceSatisfied("lead", NONE)).toBe(true);
    expect(stageEvidenceSatisfied("lost", NONE)).toBe(true);
  });
  it("production satisfied by production evidence alone (own-stage)", () => {
    expect(stageEvidenceSatisfied("production", ev({ production: true }))).toBe(true);
  });
});
