// Capabilities are the named tiers feature code asks for. The gateway (LiteLLM)
// maps these logical names to real providers. Feature code NEVER imports this map.
export const CAPABILITY_MODEL = {
  // Canonical tiers:
  reflex: "gemini-flash",      // cheap / high-volume: classify, score, route
  workhorse: "gemini-flash",   // mid: summarize, personalize copy
  reasoning: "claude-sonnet",  // flagship: judgment, drafting
  // Deprecated aliases — kept so existing drip step configs + AI_DRAFT_CAPABILITY
  // resolve. Prefer the tiers above in new code.
  "cheap-classify": "gemini-flash",
  reason: "claude-sonnet",
  summarize: "gemini-flash",
} as const;
export const EMBED_MODEL = "voyage-3";
export type Capability = keyof typeof CAPABILITY_MODEL;

// When the gateway points at Anthropic's OpenAI-compatible endpoint (local dev,
// or any deployment without a LiteLLM router in front), capabilities resolve to
// real Claude model ids instead of the logical LiteLLM names — so committed code
// works against Anthropic directly with no source edits.
export const ANTHROPIC_CAPABILITY_MODEL: Record<Capability, string> = {
  reflex: "claude-haiku-4-5-20251001",
  workhorse: "claude-haiku-4-5-20251001",
  reasoning: "claude-sonnet-4-6",
  "cheap-classify": "claude-haiku-4-5-20251001",
  reason: "claude-sonnet-4-6",
  summarize: "claude-haiku-4-5-20251001",
};

/** True when the gateway base URL targets Anthropic's OpenAI-compat endpoint. */
export function isAnthropicGateway(baseUrl: string | undefined): boolean {
  return (baseUrl ?? "").includes("api.anthropic.com");
}

/** Resolve a capability to a concrete model id for the active gateway. */
export function resolveModel(capability: Capability, baseUrl: string | undefined): string {
  return (isAnthropicGateway(baseUrl) ? ANTHROPIC_CAPABILITY_MODEL : CAPABILITY_MODEL)[capability];
}
