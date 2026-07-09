/** Check keys whose failure is a break-glass event on a non-dollar basis —
 *  active customer-facing bleed the owner must see immediately (Cell 6).
 *  When a task bound to one of these keys is unhealthy, reconcileTaskExceptions
 *  forces break_glass=true + severity="high" regardless of dollar impact. */
export const BREAK_GLASS_ON_FAIL_CHECK_KEYS: ReadonlySet<string> = new Set([
  "comms.deliverability",
  "canvass.contract_to_job",
]);
