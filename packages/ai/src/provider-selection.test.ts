import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";

// vi.mock factories are hoisted above module init, so anything they reference must
// come from vi.hoisted. Sentinels let us assert which provider factory was picked.
const { generateObjectMock, ANTHROPIC_MODEL, OPENAI_MODEL } = vi.hoisted(() => ({
  generateObjectMock: vi.fn(async (opts: { model?: unknown }) => ({ object: { ok: true }, model: opts?.model })),
  ANTHROPIC_MODEL: { __tag: "anthropic" } as unknown,
  OPENAI_MODEL: { __tag: "openai" } as unknown,
}));

vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: () => () => ANTHROPIC_MODEL }));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: () => () => OPENAI_MODEL }));
vi.mock("ai", () => ({
  generateObject: (opts: unknown) => generateObjectMock(opts as { model: unknown }),
  generateText: vi.fn(),
  embed: vi.fn(),
}));

import { completeObject } from "./client";

// The bug this guards: Anthropic's OpenAI-compat endpoint rejects file/document
// content parts, so PDF-bearing calls on the Anthropic-direct gateway must use the
// NATIVE Anthropic provider. Non-Anthropic (LiteLLM) gateways keep the compat client.
describe("completeObject provider selection for file uploads", () => {
  const prev = process.env.LITELLM_BASE_URL;
  beforeEach(() => generateObjectMock.mockClear());
  afterEach(() => { process.env.LITELLM_BASE_URL = prev; });

  const file = { bytes: new Uint8Array([1, 2, 3]), mediaType: "application/pdf" };
  const schema = z.object({ ok: z.boolean() });

  it("uses the native Anthropic provider for a file on the Anthropic gateway", async () => {
    process.env.LITELLM_BASE_URL = "https://api.anthropic.com/v1";
    await completeObject({ capability: "reasoning", prompt: "x", schema, file });
    expect(generateObjectMock).toHaveBeenCalledTimes(1);
    expect(generateObjectMock.mock.calls[0]?.[0]?.model).toBe(ANTHROPIC_MODEL);
  });

  it("uses the OpenAI-compat provider for a file on a non-Anthropic (LiteLLM) gateway", async () => {
    process.env.LITELLM_BASE_URL = "http://litellm.internal:4000/v1";
    await completeObject({ capability: "reasoning", prompt: "x", schema, file });
    expect(generateObjectMock.mock.calls[0]?.[0]?.model).toBe(OPENAI_MODEL);
  });
});
