import { describe, it, expect } from "vitest";
import { buildSageAssistant } from "./voice-persona";

describe("buildSageAssistant", () => {
  const a = buildSageAssistant({ tenantName: "Alta Roofing", tenantId: "t1", tz: "America/Denver" });

  it("exposes exactly the numbered-command tools (no lead-intake tools)", () => {
    const names = a.model.tools.map((t) => t.function.name).sort();
    expect(names).toEqual(["confirmSageAction", "readSageQueue", "resolveSageItem", "sageItemDetail"]);
  });

  it("is a tight ops persona — reads the queue, acts on numbers, not open-ended", () => {
    const sys = a.model.messages[0]!.content;
    expect(sys).toContain("Sage");
    expect(sys).toContain("Alta Roofing");
    expect(sys.toLowerCase()).toContain("number");
    // money actions must round-trip through a spoken confirmation
    expect(sys.toLowerCase()).toContain("confirm");
  });

  it("passes the tenant id through for the webhook to resolve", () => {
    expect(a.variableValues.tenantId).toBe("t1");
  });
});
