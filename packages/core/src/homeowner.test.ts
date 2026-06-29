import { describe, it, expect } from "vitest";
import { parseHomeownerConfig, homeownerStageCopy, buildHomeownerJourney } from "./homeowner";

describe("parseHomeownerConfig", () => {
  it("defaults", () => {
    expect(parseHomeownerConfig(undefined)).toEqual({ enabled: true, notifyStages: ["approved", "production", "complete"] });
  });
  it("filters invalid stages + merges", () => {
    expect(parseHomeownerConfig({ notifyStages: ["production", "nonsense", "complete"], enabled: false }))
      .toEqual({ enabled: false, notifyStages: ["production", "complete"] });
  });
});

describe("homeownerStageCopy", () => {
  it("has headline+body for every stage", () => {
    for (const s of ["lead","inspected","estimate","approved","production","closeout","billing","complete","lost"] as const) {
      const c = homeownerStageCopy(s);
      expect(c.headline.length).toBeGreaterThan(0);
      expect(c.body.length).toBeGreaterThan(0);
    }
    expect(homeownerStageCopy("approved").headline).toContain("approved");
  });
});

describe("buildHomeownerJourney", () => {
  it("marks done/current/upcoming by stage position", () => {
    const j = buildHomeownerJourney("approved");
    const by = Object.fromEntries(j.map((m) => [m.key, m.status]));
    expect(by.inspected).toBe("done");
    expect(by.estimate).toBe("done");
    expect(by.approved).toBe("current");
    expect(by.production).toBe("upcoming");
    expect(by.complete).toBe("upcoming");
    expect(j.map((m) => m.key)).toEqual(["inspected","estimate","approved","production","closeout","complete"]);
  });
});
