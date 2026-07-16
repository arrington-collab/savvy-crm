import { describe, it, expect } from "vitest";
import { quarterKeyInTimeZone, priorQuarterKey, quarterRange } from "./quarter";

describe("quarter helpers", () => {
  it("keys a date to its tenant-local quarter", () => {
    expect(quarterKeyInTimeZone(new Date("2026-07-16T18:00:00Z"), "America/Phoenix")).toBe("2026-Q3");
    expect(quarterKeyInTimeZone(new Date("2026-01-01T10:00:00Z"), "America/Phoenix")).toBe("2026-Q1");
    // 01:00Z on Apr 1 is still Mar 31 in Phoenix — Q1, not Q2.
    expect(quarterKeyInTimeZone(new Date("2026-04-01T01:00:00Z"), "America/Phoenix")).toBe("2026-Q1");
  });

  it("steps back across a year boundary", () => {
    expect(priorQuarterKey("2026-Q3")).toBe("2026-Q2");
    expect(priorQuarterKey("2026-Q1")).toBe("2025-Q4");
  });

  it("resolves a key to its civil date range (start inclusive, end exclusive)", () => {
    const r = quarterRange("2026-Q2", "America/Phoenix");
    expect(r.startCivil).toBe("2026-04-01");
    expect(r.endCivil).toBe("2026-07-01");
    expect(r.start.getTime()).toBeLessThan(r.end.getTime());
  });
});
