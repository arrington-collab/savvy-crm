import { describe, it, expect } from "vitest";
import { z } from "zod";
import { MockLanguageModelV1 } from "ai/test";
import { classifyImageWith } from "./client";

describe("classifyImage", () => {
  it("sends an image part and returns the parsed object", async () => {
    let sawImage = false;
    const model = new MockLanguageModelV1({
      defaultObjectGenerationMode: "json",
      doGenerate: async ({ prompt }) => {
        // prompt is the normalized messages array; find an image part
        const parts = Array.isArray(prompt) ? prompt.flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])) : [];
        sawImage = parts.some((p: any) => p.type === "image");
        return { finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 }, text: JSON.stringify({ usable: true }), rawCall: { rawPrompt: undefined, rawSettings: {} } };
      },
    });
    const res = await classifyImageWith(model, {
      prompt: "is this usable?", image: { bytes: new Uint8Array([1, 2, 3]) },
      schema: z.object({ usable: z.boolean() }),
    });
    expect(sawImage).toBe(true);
    expect(res.object).toEqual({ usable: true });
  });
});
