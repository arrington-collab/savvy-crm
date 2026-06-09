import { createOpenAI } from "@ai-sdk/openai";
import { generateText, generateObject, embed as aiEmbed } from "ai";
import type { z } from "zod";
import { CAPABILITY_MODEL, EMBED_MODEL, type Capability } from "./capabilities";

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
  const model = CAPABILITY_MODEL[opts.capability]!;
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
  const model = CAPABILITY_MODEL[opts.capability]!;
  const res = await generateObject({
    model: gateway()(model),
    schema: opts.schema,
    system: opts.system,
    prompt: opts.prompt,
  });
  return { object: res.object as T, model };
}

export async function embed(text: string): Promise<{ vector: number[]; model: string }> {
  const res = await aiEmbed({ model: gateway().embedding(EMBED_MODEL), value: text });
  return { vector: res.embedding, model: EMBED_MODEL };
}
