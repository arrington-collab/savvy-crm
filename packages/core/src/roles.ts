import type { ExceptionItem } from "./exception-queue";

// Phase 26 slice 6 (#353/#354) — the office-role permission matrix, as
// approved in docs/superpowers/audits/2026-07-16-phase26-s6-access-control-audit.md.
// Office = coordination, not money: scheduling, document chasing, collections
// calls, endorsement wet-signatures. Deny-by-flag: only kinds explicitly
// stamped owner-tier hide from office — a new kind defaults to visible.

/** Owner-tier card kinds: money approvals, margin, supplier-ledger exceptions. */
export const OWNER_TIER_KINDS: ReadonlySet<string> = new Set([
  "task_needs_approval",
  "margin_outlier",
  "supplier_invoice_unmatched",
  "supplier_credit_review",
  "supplier_credit_reconcile",
]);

export function canApproveMoney(role: string): boolean {
  return role === "owner" || role === "admin";
}

export function canManageSettings(role: string): boolean {
  return role === "owner" || role === "admin";
}

/** INVARIANT (#354 red path): owner-tier cards never render for office. */
export function visibleExceptionsFor(role: string, items: ExceptionItem[]): ExceptionItem[] {
  if (role !== "office") return items;
  return items.filter((i) => !OWNER_TIER_KINDS.has(i.kind));
}
