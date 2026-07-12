import * as ai from "@savvy/ai";
import { chooseShiftReport, shiftReportPrompt, type AgentCoverage } from "@savvy/core";

/** Just the gateway method the composer needs — injectable so tests never hit the network. */
export type ShiftAiClient = Pick<typeof ai, "complete">;

/**
 * Compose the narrative shift report from real agent-coverage numbers via the AI
 * gateway's cheap "workhorse" capability (never a hard-coded model — CLAUDE.md #2).
 * Fail-soft: any gateway error, or a model that returns hype, falls back to the
 * deterministic template. `modelUsed` is the model id ONLY when the model's own
 * text actually shipped — honest telemetry, not "we tried a model".
 */
export async function composeShiftReport(
  coverage: AgentCoverage[],
  aiClient: ShiftAiClient = ai,
): Promise<{ narrative: string; modelUsed: string | null }> {
  let text: string | null;
  let model: string | null;
  try {
    const { system, prompt } = shiftReportPrompt(coverage);
    const res = await aiClient.complete({ capability: "workhorse", system, prompt });
    text = res.text;
    model = res.model;
  } catch {
    // fail-soft: template fallback below
    text = null;
    model = null;
  }
  const narrative = chooseShiftReport(text, coverage);
  const modelUsed = text != null && narrative === text.trim() ? model : null;
  return { narrative, modelUsed };
}
