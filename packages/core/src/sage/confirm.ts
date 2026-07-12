import type { SageActionKind, SageDigestItem } from "./types";

/** Money actions — the only ones that can trip the confirm round-trip. */
const MONEY_ACTIONS: ReadonlySet<SageActionKind> = new Set(["approve_estimate", "send_invoice"]);
const NOUNS: Partial<Record<SageActionKind, string>> = {
  approve_estimate: "estimate",
  send_invoice: "invoice",
};
const VERBS: Record<SageActionKind, string> = {
  approve_estimate: "approve",
  send_invoice: "send",
  complete_task: "complete",
  send_credit: "send credit request",
};

/** Rounded USD with thousands separators, e.g. 3275000 → "$32,750". */
export function usdCents(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

/**
 * Whether a money action needs a "Reply YES" round-trip: true only when the
 * action moves money, the tenant set an approval threshold, and the amount
 * exceeds it. Non-money actions never confirm.
 */
export function requiresConfirm(
  item: SageDigestItem,
  cfg: { approvalThresholdCents: number | null },
): boolean {
  if (!item.action || !MONEY_ACTIONS.has(item.action)) return false;
  if (cfg.approvalThresholdCents === null || item.confirmAmountCents === null) return false;
  return item.confirmAmountCents > cfg.approvalThresholdCents;
}

/** The confirm prompt, e.g. "Reply YES to approve $32,750 estimate to Kowalski". */
export function confirmPrompt(item: SageDigestItem): string {
  const verb = item.action ? VERBS[item.action] : "act on";
  const noun = (item.action && NOUNS[item.action]) ?? "item";
  const amount = item.confirmAmountCents === null ? "" : `${usdCents(item.confirmAmountCents)} `;
  return `Reply YES to ${verb} ${amount}${noun} to ${item.title}`;
}
