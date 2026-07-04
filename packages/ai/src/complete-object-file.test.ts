import { describe, it, expect } from "vitest";
import { z } from "zod";
import { MockLanguageModelV1 } from "ai/test";
import { completeObjectWith } from "./client";

// completeObjectWith mirrors classifyImageWith: it lets a structured-extraction
// call carry a document (e.g. a supplier-invoice PDF) as a file content part so
// the model actually sees the file, not just a text prompt.
describe("completeObjectWith", () => {
  const doGenerate = (sawRef: { file: boolean }) => async ({ prompt }: { prompt: unknown }) => {
    const parts = Array.isArray(prompt)
      ? prompt.flatMap((m: { content?: unknown }) => (Array.isArray(m.content) ? m.content : []))
      : [];
    sawRef.file = parts.some((p: { type?: string }) => p.type === "file");
    return {
      finishReason: "stop" as const,
      usage: { promptTokens: 1, completionTokens: 1 },
      text: JSON.stringify({ ok: true }),
      rawCall: { rawPrompt: undefined, rawSettings: {} },
    };
  };

  it("sends a file part when a file is provided", async () => {
    const saw = { file: false };
    const model = new MockLanguageModelV1({ defaultObjectGenerationMode: "json", doGenerate: doGenerate(saw) });
    const res = await completeObjectWith(model, {
      prompt: "parse this invoice",
      schema: z.object({ ok: z.boolean() }),
      file: { bytes: new Uint8Array([1, 2, 3]), mediaType: "application/pdf" },
    });
    expect(saw.file).toBe(true);
    expect(res.object).toEqual({ ok: true });
  });

  it("sends no file part when no file is provided", async () => {
    const saw = { file: false };
    const model = new MockLanguageModelV1({ defaultObjectGenerationMode: "json", doGenerate: doGenerate(saw) });
    const res = await completeObjectWith(model, { prompt: "hello", schema: z.object({ ok: z.boolean() }) });
    expect(saw.file).toBe(false);
    expect(res.object).toEqual({ ok: true });
  });
});
