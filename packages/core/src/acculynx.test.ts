import { describe, it, expect } from "vitest";
import { mapAccuLynxMilestone, mapAccuLynxLeadSource, mapAccuLynxWorkType } from "./acculynx";

describe("mapAccuLynxMilestone", () => {
  it("maps an assigned lead to a Savvy lead entity (no job yet)", () => {
    expect(mapAccuLynxMilestone("Lead")).toEqual({ kind: "lead" });
  });

  it("maps working milestones onto job stages", () => {
    expect(mapAccuLynxMilestone("Prospect")).toEqual({ kind: "job", stage: "estimate" });
    expect(mapAccuLynxMilestone("Approved")).toEqual({ kind: "job", stage: "approved" });
    expect(mapAccuLynxMilestone("Completed")).toEqual({ kind: "job", stage: "closeout" });
    expect(mapAccuLynxMilestone("Invoiced")).toEqual({ kind: "job", stage: "billing" });
    expect(mapAccuLynxMilestone("Closed")).toEqual({ kind: "job", stage: "complete" });
    expect(mapAccuLynxMilestone("Dead")).toEqual({ kind: "job", stage: "lost" });
  });

  it("routes an unknown milestone to a lead (never drops a record silently)", () => {
    expect(mapAccuLynxMilestone("SomethingNew")).toEqual({ kind: "lead" });
  });
});

describe("mapAccuLynxLeadSource — onto the Savvy source taxonomy", () => {
  it("maps the observed Alta sources", () => {
    expect(mapAccuLynxLeadSource("Referral")).toEqual({ source: "referral", detail: "Referral" });
    expect(mapAccuLynxLeadSource("Internet")).toEqual({ source: "web", detail: "Internet" });
    expect(mapAccuLynxLeadSource("Angie")).toEqual({ source: "ads", detail: "Angie" });
    expect(mapAccuLynxLeadSource("Personal")).toEqual({ source: "other", detail: "Personal" });
    expect(mapAccuLynxLeadSource("Other")).toEqual({ source: "other", detail: "Other" });
  });

  it("keeps the original wording for anything unmapped", () => {
    expect(mapAccuLynxLeadSource("Home Show Booth")).toEqual({ source: "other", detail: "Home Show Booth" });
    expect(mapAccuLynxLeadSource(null)).toEqual({ source: "other", detail: null });
  });
});

describe("mapAccuLynxWorkType", () => {
  it("maps Retail/Insurance and defaults to retail", () => {
    expect(mapAccuLynxWorkType(["Retail"])).toBe("retail");
    expect(mapAccuLynxWorkType(["Insurance"])).toBe("insurance");
    expect(mapAccuLynxWorkType(["Insurance", "Retail"])).toBe("insurance");
    expect(mapAccuLynxWorkType([])).toBe("retail");
    expect(mapAccuLynxWorkType(undefined)).toBe("retail");
  });
});
