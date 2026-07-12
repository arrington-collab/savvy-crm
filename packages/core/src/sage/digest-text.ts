import type { SageActionKind, SageDigestItem } from "./types";

const VERBS: Record<SageActionKind, string> = {
  approve_estimate: "approve",
  send_invoice: "send",
  complete_task: "complete",
  send_credit: "send credit request",
};

/** Imperative verb shown in the reply-to-act suffix ("reply 1 to approve"). */
export function actionVerb(action: SageActionKind): string {
  return VERBS[action];
}

/**
 * Render a numbered digest the owner can reply to. Actionable items get a
 * "reply N to <verb>" suffix; non-actionable items get "reply N for detail"
 * (they surface in the readout but only the handler-backed subset resolves).
 * Pure — no timestamps, so no timezone needed.
 */
export function buildSageDigestText(items: SageDigestItem[]): { body: string; count: number } {
  if (items.length === 0) return { body: "", count: 0 };
  const lines = items.map((it, i) => {
    const n = i + 1;
    const suffix = it.action ? `reply ${n} to ${actionVerb(it.action)}` : `reply ${n} for detail`;
    return `(${n}) ${it.title} — ${it.detail} — ${suffix}`;
  });
  const body = [`Savvy: ${items.length} to act`, ...lines].join("\n");
  return { body, count: items.length };
}

/** One-line detail reply for "N?" — title, detail, and a deep link when a job exists. */
export function describeSageItem(item: SageDigestItem, n: number): string {
  const base = `(${n}) ${item.title} — ${item.detail}`;
  return item.jobId ? `${base} · /jobs/${item.jobId}` : base;
}
