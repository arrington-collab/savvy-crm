import { describe, it, expect } from "vitest";
import { verbFor } from "./agent-verbs";

describe("verbFor", () => {
  it("maps known task keys to plain words", () => {
    expect(verbFor("lead.rep.alert").verb).toBe("alerted the rep");
    expect(verbFor("ops.digest").verb).toBe("sent the daily digest");
  });
  it("humanizes unknown dotted keys as a fallback (never the raw key)", () => {
    const r = verbFor("finance.qb.reconcile");
    expect(r.verb).not.toContain(".");
    expect(r.verb.length).toBeGreaterThan(0);
    expect(r.category).toBe("finance");
  });
  it("handles null", () => {
    expect(verbFor(null).verb).toBe("took an action");
  });
});
