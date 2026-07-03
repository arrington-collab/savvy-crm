import { createOpenAI } from "@ai-sdk/openai";
import { generateText, generateObject, embed as aiEmbed } from "ai";
import type { LanguageModelV1 } from "ai";
import type { z } from "zod";
import { EMBED_MODEL, resolveModel, isAnthropicGateway, type Capability } from "./capabilities";

const gateway = () =>
  createOpenAI({
    // LiteLLM exposes an OpenAI-compatible API. Both vars come from env.
    baseURL: process.env.LITELLM_BASE_URL ?? "http://localhost:4000/v1",
    apiKey: process.env.LITELLM_API_KEY ?? "sk-noop",
  });

export async function complete(opts: {
  capability: Capability;
  prompt: string;
  system?: string;
}): Promise<{ text: string; model: string }> {
  const model = resolveModel(opts.capability, process.env.LITELLM_BASE_URL);
  const res = await generateText({
    model: gateway()(model),
    system: opts.system,
    prompt: opts.prompt,
  });
  return { text: res.text, model };
}

export async function completeObject<T>(opts: {
  capability: Capability;
  prompt: string;
  schema: z.ZodType<T>;
  system?: string;
}): Promise<{ object: T; model: string }> {
  const model = resolveModel(opts.capability, process.env.LITELLM_BASE_URL);
  const res = await generateObject({
    model: gateway()(model),
    // Anthropic's OpenAI-compat endpoint needs tool-mode for structured output;
    // LiteLLM/OpenAI use the SDK default.
    ...(isAnthropicGateway(process.env.LITELLM_BASE_URL) ? { mode: "tool" as const } : {}),
    schema: opts.schema,
    system: opts.system,
    prompt: opts.prompt,
  });
  return { object: res.object as T, model };
}

/** Vision classify against an explicit model (used by tests + the public wrapper). */
export async function classifyImageWith<T>(
  model: LanguageModelV1,
  opts: { prompt: string; system?: string; image: { bytes: Uint8Array }; schema: z.ZodType<T>; anthropic?: boolean },
): Promise<{ object: T; model: string }> {
  const res = await generateObject({
    model,
    ...(opts.anthropic ? { mode: "tool" as const } : {}),
    schema: opts.schema,
    system: opts.system,
    messages: [{ role: "user", content: [{ type: "text", text: opts.prompt }, { type: "image", image: opts.image.bytes }] }],
  });
  return { object: res.object as T, model: (model as { modelId?: string }).modelId ?? "unknown" };
}

export async function classifyImage<T>(opts: {
  capability: Capability; prompt: string; system?: string; image: { bytes: Uint8Array }; schema: z.ZodType<T>;
}): Promise<{ object: T; model: string }> {
  const modelId = resolveModel(opts.capability, process.env.LITELLM_BASE_URL);
  const anthropic = isAnthropicGateway(process.env.LITELLM_BASE_URL);
  const { object } = await classifyImageWith(gateway()(modelId), { ...opts, anthropic });
  return { object, model: modelId };
}

export async function embed(text: string): Promise<{ vector: number[]; model: string }> {
  const res = await aiEmbed({ model: gateway().embedding(EMBED_MODEL), value: text });
  return { vector: res.embedding, model: EMBED_MODEL };
}
