import { describe, it, expect } from "vitest";
import { nextAutomationLevel } from "./automation-level";

describe("nextAutomationLevel", () => {
  it("cycles manual → partial → full → manual (promote, then wrap)", () => {
    expect(nextAutomationLevel("manual")).toBe("partial");
    expect(nextAutomationLevel("partial")).toBe("full");
    expect(nextAutomationLevel("full")).toBe("manual");
  });
});
