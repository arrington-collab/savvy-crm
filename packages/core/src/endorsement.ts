// Cell 16 mortgage-endorsement chase — pure model. When an insurance claim
// payment names a mortgage lender as co-payee, the check must be endorsed by the
// lender before the homeowner can use the funds. This machinery detects the need
// and enforces a 5-business-day no-idle SLA on open endorsements.

export const ENDORSEMENT_STATUS = ["none", "needed", "requested", "received", "not_applicable"] as const;
export type EndorsementStatus = (typeof ENDORSEMENT_STATUS)[number];

// Open states still awaiting the lender — these are the ones the SLA watches.
const OPEN_ENDORSEMENT = new Set<EndorsementStatus>(["needed", "requested"]);

const utcMidnight = (d: Date): number => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

/**
 * Weekdays (Mon–Fri) elapsed in the half-open range (from, to] — i.e. the count
 * of business days that have passed since `from` up to and including `to`'s day.
 * Weekends are skipped; holidays are not modelled. 0 for same-day/reversed.
 */
export function businessDaysBetween(from: Date, to: Date): number {
  if (to <= from) return 0;
  const DAY = 86_400_000;
  const end = utcMidnight(to);
  let cur = utcMidnight(from) + DAY;
  let count = 0;
  while (cur <= end) {
    const dow = new Date(cur).getUTCDay(); // 0 Sun … 6 Sat
    if (dow !== 0 && dow !== 6) count++;
    cur += DAY;
  }
  return count;
}

/** A lender co-payee name on the claim means an endorsement is required. */
export function endorsementNeeded(input: { lenderName?: string | null }): boolean {
  return !!(input.lenderName && input.lenderName.trim().length > 0);
}

/**
 * True when an OPEN endorsement (needed/requested) has been idle for more than
 * `maxBusinessDays` business days. `lastActionAt` is the last chase touch; when
 * null (never touched) idle is measured from `fallback` (e.g. the claim's
 * created_at). received / not_applicable / none are never idle.
 */
export function isEndorsementIdle(
  status: string,
  lastActionAt: Date | null,
  now: Date,
  maxBusinessDays = 5,
  fallback?: Date,
): boolean {
  if (!OPEN_ENDORSEMENT.has(status as EndorsementStatus)) return false;
  const since = lastActionAt ?? fallback ?? now;
  return businessDaysBetween(since, now) > maxBusinessDays;
}
