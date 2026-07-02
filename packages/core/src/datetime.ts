// Customer-facing date/time display helpers. en-US is intentional (US roofing
// market). Every format pins an explicit `timeZone` so output is byte-identical
// on the server and the browser — a bare toLocale*/new Date() in a rendered
// component uses the ambient timezone/clock and triggers a React hydration
// mismatch (which silently discards the subtree, including any typed input).

// YYYY-MM-DD for a Date as observed in `tz` (en-CA yields ISO order).
function dayKeyInTz(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * Human-friendly slot label: relative day ("Today" / "Tomorrow", else
 * "Thu, Jul 2") + a 12-hour time with no seconds ("2:00 PM").
 * `now` is injected so the relative-day math is testable and deterministic;
 * `tz` (an IANA zone) makes the output timezone-explicit and hydration-safe.
 * Compute this on the server and pass the string to client components.
 */
export function formatSlotLabel(start: Date, now: Date, tz: string): string {
  const startKey = dayKeyInTz(start, tz);
  const nowKey = dayKeyInTz(now, tz);
  const diffDays = Math.round(
    (Date.parse(`${startKey}T00:00:00Z`) - Date.parse(`${nowKey}T00:00:00Z`)) / 86_400_000,
  );

  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(start);
  let day: string;
  if (diffDays === 0) day = "Today";
  else if (diffDays === 1) day = "Tomorrow";
  else
    day = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      month: "short",
      day: "numeric",
    }).format(start);

  return `${day}, ${time}`;
}
