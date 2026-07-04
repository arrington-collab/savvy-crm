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
  // Optional document (e.g. a supplier-invoice PDF) sent as a file content part
  // so the model can read the actual file, not just a text prompt.
  file?: { bytes: Uint8Array; mediaType: string };
}): Promise<{ object: T; model: string }> {
  const model = resolveModel(opts.capability, process.env.LITELLM_BASE_URL);
  const anthropic = isAnthropicGateway(process.env.LITELLM_BASE_URL);
  if (opts.file) {
    // File attached → use the messages API (via completeObjectWith) to carry it.
    const { object } = await completeObjectWith(gateway()(model), {
      prompt: opts.prompt,
      system: opts.system,
      schema: opts.schema,
      file: opts.file,
      anthropic,
    });
    return { object, model };
  }
  const res = await generateObject({
    model: gateway()(model),
    // Anthropic's OpenAI-compat endpoint needs tool-mode for structured output;
    // LiteLLM/OpenAI use the SDK default.
    ...(anthropic ? { mode: "tool" as const } : {}),
    schema: opts.schema,
    system: opts.system,
    prompt: opts.prompt,
  });
  return { object: res.object as T, model };
}

/** Structured extraction against an explicit model, optionally carrying a file
 *  (document/PDF) as a content part. Mirrors `classifyImageWith` for images so
 *  the model sees the real bytes; used by the supplier-invoice parser. */
export async function completeObjectWith<T>(
  model: LanguageModelV1,
  opts: { prompt: string; system?: string; schema: z.ZodType<T>; file?: { bytes: Uint8Array; mediaType: string }; anthropic?: boolean },
): Promise<{ object: T; model: string }> {
  const content: Array<
    { type: "text"; text: string } | { type: "file"; data: Uint8Array; mimeType: string }
  > = [{ type: "text", text: opts.prompt }];
  if (opts.file) content.push({ type: "file", data: opts.file.bytes, mimeType: opts.file.mediaType });
  const res = await generateObject({
    model,
    ...(opts.anthropic ? { mode: "tool" as const } : {}),
    schema: opts.schema,
    system: opts.system,
    messages: [{ role: "user", content }],
  });
  return { object: res.object as T, model: (model as { modelId?: string }).modelId ?? "unknown" };
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
