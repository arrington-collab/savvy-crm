// Capabilities are what feature code asks for. The gateway (LiteLLM) maps these
// logical model names to real providers. Feature code NEVER imports this map.
export const CAPABILITY_MODEL: Record<string, string> = {
  "cheap-classify": "gemini-flash",
  "reason": "claude-sonnet",
  "summarize": "gemini-flash",
};
export const EMBED_MODEL = "voyage-3";
export type Capability = keyof typeof CAPABILITY_MODEL;
