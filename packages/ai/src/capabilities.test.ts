import { describe, it, expect } from "vitest";
import { resolveModel, isAnthropicGateway } from "./capabilities";

describe("capability gateway resolution", () => {
  it("uses logical LiteLLM names by default (no LiteLLM/anthropic url)", () => {
    expect(isAnthropicGateway(undefined)).toBe(false);
    expect(resolveModel("reflex", undefined)).toBe("gemini-flash");
    expect(resolveModel("reasoning", "http://localhost:4000/v1")).toBe("claude-sonnet");
  });

  it("uses real Claude ids when pointed at Anthropic's compat endpoint", () => {
    const url = "https://api.anthropic.com/v1";
    expect(isAnthropicGateway(url)).toBe(true);
    expect(resolveModel("reflex", url)).toBe("claude-haiku-4-5-20251001");
    expect(resolveModel("reasoning", url)).toBe("claude-sonnet-4-6");
    // deprecated aliases still resolve
    expect(resolveModel("reason", url)).toBe("claude-sonnet-4-6");
  });
});
