import { describe, it, expect, vi } from "vitest";
import { draftMessage } from "./drip";

const ctx = { name: "Jane Homeowner", firstName: "Jane" };

describe("draftMessage", () => {
  it("template step: renders body, aiHandled=false, no AI call", async () => {
    const ai = { complete: vi.fn() };
    const res = await draftMessage(
      { step: { stepNum: 1, delayHours: 0, channel: "sms", templateKey: "welcome" }, templateBody: "Hi {{firstName}}!", ctx },
      ai as never,
    );
    expect(res.body).toBe("Hi Jane!");
    expect(res.aiHandled).toBe(false);
    expect(ai.complete).not.toHaveBeenCalled();
  });

  it("AI step: calls the gateway with the step prompt, aiHandled=true", async () => {
    const ai = { complete: vi.fn().mockResolvedValue({ text: "Drafted hello", model: "gemini-flash" }) };
    const res = await draftMessage(
      { step: { stepNum: 2, delayHours: 0, channel: "email", aiPrompt: "Write a friendly nudge" }, ctx },
      ai as never,
    );
    expect(res.body).toBe("Drafted hello");
    expect(res.aiHandled).toBe(true);
    expect(res.model).toBe("gemini-flash");
    expect(ai.complete).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "summarize" }),
    );
  });

  it("AI step honors an explicit aiCapability", async () => {
    const ai = { complete: vi.fn().mockResolvedValue({ text: "x", model: "claude-sonnet" }) };
    await draftMessage(
      { step: { stepNum: 3, delayHours: 0, channel: "sms", aiPrompt: "nuanced", aiCapability: "reason" }, ctx },
      ai as never,
    );
    expect(ai.complete).toHaveBeenCalledWith(expect.objectContaining({ capability: "reason" }));
  });
});
