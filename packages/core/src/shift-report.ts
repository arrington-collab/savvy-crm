import type { AgentCoverage } from "./agent-activity";

/**
 * Marketing / hype adjectives a factual ops report must never contain. The shift
 * report describes what the machine actually did — plain numbers, no theater — so
 * any of these words in the model's output means we distrust it and fall back to
 * the deterministic template. Lowercased; matched as whole words, case-insensitive.
 */
export const HYPE_WORDS: readonly string[] = [
  "amazing",
  "incredible",
  "blazing",
  "blazingly",
  "revolutionary",
  "game-changing",
  "unbelievable",
  "stunning",
  "phenomenal",
  "supercharged",
  "turbocharged",
  "world-class",
  "best-in-class",
  "cutting-edge",
  "next-level",
  "seamless",
  "seamlessly",
  "effortless",
  "effortlessly",
  "flawless",
  "flawlessly",
  "magical",
  "insanely",
  "lightning-fast",
  "extraordinary",
  "mind-blowing",
  "jaw-dropping",
  "breathtaking",
  "spectacular",
  "awesome",
  "wonderful",
  "unmatched",
  "unrivaled",
  "tirelessly",
  "relentlessly",
];

// Word boundaries around whole words; hyphenated entries (e.g. "game-changing")
// work because "-" is a non-word char so \b sits at each end. Built once.
const HYPE_PATTERNS: readonly [string, RegExp][] = HYPE_WORDS.map((w) => [
  w,
  new RegExp(`(^|[^a-z0-9])${w.replace(/[-]/g, "\\-")}([^a-z0-9]|$)`, "i"),
]);

/** Hype words present in `text` (deduped, lowercased). Empty array = factual. */
export function findHypeWords(text: string): string[] {
  const hits: string[] = [];
  for (const [word, re] of HYPE_PATTERNS) {
    if (re.test(text)) hits.push(word);
  }
  return hits;
}

/** True when `text` contains no marketing/hype adjectives. */
export function isFactual(text: string): boolean {
  return findHypeWords(text).length === 0;
}

/** Only agents that actually did something (the roster includes all five). */
function activeAgents(coverage: AgentCoverage[]): AgentCoverage[] {
  return coverage.filter((c) => c.total > 0);
}

/**
 * Deterministic, first-person narrative built purely from the coverage numbers.
 * This is the honest fallback (and the yardstick the model must beat) — it can
 * only ever state what the counts say, and it never contains hype.
 */
export function templateShiftReport(coverage: AgentCoverage[]): string {
  const active = activeAgents(coverage);
  const total = active.reduce((sum, c) => sum + c.total, 0);
  if (total === 0) return "No agent activity in the last 24 hours.";

  const errors = active.reduce((sum, c) => sum + c.error, 0);
  const skipped = active.reduce((sum, c) => sum + c.skipped, 0);
  const breakdown = active.map((c) => `${c.label} ${c.total}`).join(", ");
  const agentNoun = active.length === 1 ? "agent" : "agents";
  const actionNoun = total === 1 ? "action" : "actions";

  let s = `In the last 24h I ran ${total} ${actionNoun} across ${active.length} ${agentNoun}: ${breakdown}.`;
  if (errors > 0) s += ` ${errors} need${errors === 1 ? "s" : ""} a look.`;
  if (skipped > 0) s += ` ${skipped} ${skipped === 1 ? "was a no-op" : "were no-ops"}.`;
  return s;
}

/**
 * Build the gateway request that asks a cheap model to phrase the same numbers.
 * The system prompt forbids hype and caps length; the prompt carries only the
 * real per-agent counts, so the model has no room to invent activity.
 */
export function shiftReportPrompt(coverage: AgentCoverage[]): { system: string; prompt: string } {
  const active = activeAgents(coverage);
  const total = active.reduce((sum, c) => sum + c.total, 0);
  const facts = active
    .map((c) => `${c.label}: ${c.total} run(s), ${c.ok} ok, ${c.error} error, ${c.skipped} skipped`)
    .join("\n");

  const system =
    "You write a short, first-person overnight shift report for a roofing company's AI operations team. " +
    "State ONLY the facts you are given — never invent numbers or activity. Be plain and factual. " +
    "Do NOT use marketing or hype adjectives (no 'amazing', 'incredible', 'seamless', 'tirelessly', etc.). " +
    "No exclamation points. Two to three sentences, no more.";

  const prompt = `Total actions in the last 24h: ${total}\nPer agent:\n${facts || "(no activity)"}\n\nWrite the shift report.`;
  return { system, prompt };
}

// A real 2–3 sentence narrative fits comfortably under this; anything longer is a
// runaway/hallucinating model, so we distrust it and fall back to the template.
const MAX_NARRATIVE_CHARS = 600;

/**
 * The honesty gate. Ship the model's text ONLY when it is present, non-empty,
 * within the length cap, and free of hype; otherwise ship the deterministic
 * template built from the same numbers. Guarantees no hype ever reaches the owner.
 */
export function chooseShiftReport(modelText: string | null, coverage: AgentCoverage[]): string {
  const template = templateShiftReport(coverage);
  if (modelText == null) return template;
  const trimmed = modelText.trim();
  if (!trimmed) return template;
  if (trimmed.length > MAX_NARRATIVE_CHARS) return template;
  if (!isFactual(trimmed)) return template;
  return trimmed;
}
