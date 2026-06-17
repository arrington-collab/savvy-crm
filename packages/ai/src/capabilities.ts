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
