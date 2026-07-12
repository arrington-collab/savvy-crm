import type { SageActionKind } from "./types";

const VOICE_VERBS: Record<SageActionKind, string> = {
  approve_estimate: "approve the estimate",
  send_invoice: "send the invoice",
  complete_task: "complete the task",
  send_credit: "send the credit request",
};

/** Spoken phrase for an action (or "review" for a non-actionable item). */
export function voiceActionVerb(action: SageActionKind | null): string {
  return action ? VOICE_VERBS[action] : "review";
}

/**
 * Read the numbered queue aloud for the Sage voice line. Pure. The owner then
 * says a number to act, or "detail" + a number to hear more — the same numbered
 * mapping the SMS digest uses, so text and voice stay consistent.
 */
export function buildSpokenQueue(items: { title: string; action: SageActionKind | null }[]): string {
  if (items.length === 0) return "You're all clear — nothing needs you right now.";
  const lines = items.map((it, i) => `${i + 1}: ${voiceActionVerb(it.action)} for ${it.title}.`);
  const count = items.length === 1 ? "1 item" : `${items.length} items`;
  return `You have ${count}. ${lines.join(" ")} Say a number to act on it, or say "detail" and a number to hear more.`;
}
