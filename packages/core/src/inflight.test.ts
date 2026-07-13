import { describe, it, expect } from "vitest";
import { shapeInflight } from "./inflight";

const now = new Date("2026-07-11T12:00:00Z");
describe("shapeInflight", () => {
  it("keys fresh running runs by job and lead with a verb", () => {
    const out = shapeInflight([
      { agent: "orchestrator", taskKey: "estimate.generate", jobId: "j1", leadId: null, startedAt: new Date(now.getTime() - 5000) },
      { agent: "orchestrator", taskKey: "lead.doc_parse", jobId: null, leadId: "l1", startedAt: new Date(now.getTime() - 2000) },
    ], now, 90);
    expect(out.jobs["j1"]!.verb.length).toBeGreaterThan(0);
    expect(out.leads["l1"]!.verb.length).toBeGreaterThan(0);
  });
  it("drops runs older than maxSeconds (no stuck spinner)", () => {
    const out = shapeInflight([
      { agent: "orchestrator", taskKey: "x", jobId: "j1", leadId: null, startedAt: new Date(now.getTime() - 120_000) },
    ], now, 90);
    expect(out.jobs["j1"]).toBeUndefined();
  });
  it("keeps the newest run per entity", () => {
    const out = shapeInflight([
      { agent: "a", taskKey: "old", jobId: "j1", leadId: null, startedAt: new Date(now.getTime() - 8000) },
      { agent: "a", taskKey: "new", jobId: "j1", leadId: null, startedAt: new Date(now.getTime() - 1000) },
    ], now, 90);
    // "new" verb wins
    expect(out.jobs["j1"]!.startedAt).toBe(new Date(now.getTime() - 1000).toISOString());
  });
});
