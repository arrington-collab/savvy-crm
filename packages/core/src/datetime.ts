// Customer-facing date/time display helpers. en-US is intentional (US roofing
// market) so output is stable across server/client and test runners.

/**
 * Human-friendly slot label: relative day ("Today" / "Tomorrow", else
 * "Thu, Jul 2") + a 12-hour time with no seconds ("2:00 PM").
 * `now` is injected so the relative-day math is testable and deterministic.
 */
export function formatSlotLabel(start: Date, now: Date): string {
  const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const nowDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((startDay.getTime() - nowDay.getTime()) / 86_400_000);

  const time = start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  let day: string;
  if (diffDays === 0) day = "Today";
  else if (diffDays === 1) day = "Tomorrow";
  else day = start.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

  return `${day}, ${time}`;
}
