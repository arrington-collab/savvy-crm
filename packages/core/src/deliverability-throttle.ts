import { DELIVERY_RATE_FLOOR } from "./verification/deliverability";

export const MIN_SAMPLE = 20;

/** True when we have enough terminal receipts to trust the rate AND it's below floor. */
export function shouldThrottleOutbound(
  agg: { delivered: number; failed: number; undelivered: number },
  floor: number = DELIVERY_RATE_FLOOR,
): boolean {
  const total = agg.delivered + agg.failed + agg.undelivered;
  if (total < MIN_SAMPLE) return false;
  return agg.delivered / total < floor;
}
