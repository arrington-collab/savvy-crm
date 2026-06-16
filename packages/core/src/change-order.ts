/**
 * Change-order line items reuse @savvy/core's EstimateLineItem shape; only the
 * sum is needed here. A change order has no separate tax line (the delta is the
 * figure that adjusts the contract and is invoiced), so subtotal === total.
 */
export function computeChangeOrderTotal(lines: { amountCents: number }[]): { subtotal: number; total: number } {
  const subtotal = lines.reduce((s, l) => s + l.amountCents, 0);
  return { subtotal, total: subtotal };
}
