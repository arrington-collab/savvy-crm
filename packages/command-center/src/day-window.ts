export const BUSINESS_TZ = "America/Denver";

// Parts of an instant, rendered in the business timezone, via native Intl
// (the finance.ts/datetime.ts precedent — no date-fns-tz dependency).
function denverParts(d: Date): { y: number; m: number; day: number; h: number; min: number; s: number } {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(d)) if (part.type !== "literal") p[part.type] = part.value;
  // Intl can emit hour "24" at midnight; normalize to 0.
  const h = p.hour === "24" ? 0 : Number(p.hour);
  return { y: Number(p.year), m: Number(p.month), day: Number(p.day), h, min: Number(p.minute), s: Number(p.second) };
}

/** The YYYY-MM-DD Denver calendar date an instant falls in. */
export function businessDateOf(occurredAtUtc: string | Date): string {
  const d = typeof occurredAtUtc === "string" ? new Date(occurredAtUtc) : occurredAtUtc;
  const { y, m, day } = denverParts(d);
  return `${y.toString().padStart(4, "0")}-${m.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

/** The UTC instant that is 00:00:00 Denver on the given YYYY-MM-DD. */
function denverMidnightUtc(businessDate: string): Date {
  const [y, m, d] = businessDate.split("-").map(Number);
  // Guess local-noon UTC for the date, read back the Denver offset, then correct.
  // Two-pass is robust across DST boundaries.
  let guess = new Date(Date.UTC(y!, m! - 1, d!, 12, 0, 0));
  for (let i = 0; i < 2; i++) {
    const parts = denverParts(guess);
    const asUtcOfDenverWallClock = Date.UTC(parts.y, parts.m - 1, parts.day, parts.h, parts.min, parts.s);
    const offsetMs = asUtcOfDenverWallClock - guess.getTime(); // Denver = UTC + offsetMs
    // We want Denver wall clock = date 00:00:00 → its UTC = Date.UTC(date,0,0,0) - offsetMs
    guess = new Date(Date.UTC(y!, m! - 1, d!, 0, 0, 0) - offsetMs);
  }
  return guess;
}

export function denverDayWindow(businessDate: string): { startUtc: Date; endUtc: Date } {
  const startUtc = denverMidnightUtc(businessDate);
  const [y, m, d] = businessDate.split("-").map(Number);
  const next = new Date(Date.UTC(y!, m! - 1, d! + 1));
  const nextDate = `${next.getUTCFullYear()}-${(next.getUTCMonth() + 1).toString().padStart(2, "0")}-${next.getUTCDate().toString().padStart(2, "0")}`;
  return { startUtc, endUtc: denverMidnightUtc(nextDate) };
}
