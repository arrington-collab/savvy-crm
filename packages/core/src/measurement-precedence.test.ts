import { describe, it, expect } from "vitest";
import { selectPreferredMeasurement } from "./measurement-precedence";

const d = (ms: number) => new Date(1_700_000_000_000 + ms);

describe("selectPreferredMeasurement", () => {
  it("returns null for an empty list", () => {
    expect(selectPreferredMeasurement([])).toBeNull();
  });

  it("prefers ordered over uploaded_report over sketch", () => {
    const rows = [
      { id: "sk", source: "sketch", createdAt: d(300) },
      { id: "up", source: "uploaded_report", createdAt: d(200) },
      { id: "or", source: "ordered", createdAt: d(100) },
    ];
    expect(selectPreferredMeasurement(rows)!.id).toBe("or");
  });

  it("uploaded_report beats a newer sketch", () => {
    const rows = [
      { id: "sk", source: "sketch", createdAt: d(999) },
      { id: "up", source: "uploaded_report", createdAt: d(1) },
    ];
    expect(selectPreferredMeasurement(rows)!.id).toBe("up");
  });

  it("within the same source, newest wins", () => {
    const rows = [
      { id: "old", source: "uploaded_report", createdAt: d(100) },
      { id: "new", source: "uploaded_report", createdAt: d(500) },
    ];
    expect(selectPreferredMeasurement(rows)!.id).toBe("new");
  });

  it("ranks unknown/null source below sketch", () => {
    const rows = [
      { id: "legacy", source: null, createdAt: d(900) },
      { id: "sk", source: "sketch", createdAt: d(100) },
    ];
    expect(selectPreferredMeasurement(rows)!.id).toBe("sk");
  });
});
