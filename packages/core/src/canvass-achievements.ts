import { bestStreak } from "./canvass-streak";
import { dateKeyInTimeZone, hourInTimeZone } from "./tz";

export interface BadgeDef {
  key: string;
  name: string;
}

export const CANVASS_BADGES: BadgeDef[] = [
  { key: "first_sale", name: "First Blood" },
  { key: "doors_100", name: "Century" },
  { key: "doors_1000", name: "Grand" },
  { key: "hot_hand", name: "Hot Hand" },
  { key: "streak_5", name: "Iron Streak 5" },
  { key: "streak_10", name: "Iron Streak 10" },
  { key: "streak_30", name: "Iron Streak 30" },
  { key: "rainmaker", name: "Rainmaker" },
  { key: "early_bird", name: "Early Bird" },
];

export interface AchievementKnock {
  outcome: string;
  amount?: number | null;
  at: Date;
}

export interface AchievementInput {
  knocks: AchievementKnock[];
  tz: string;
  now?: Date;
}

function hotHand(times: number[]): boolean {
  const sorted = [...times].sort((a, b) => a - b);
  for (let i = 0; i + 9 < sorted.length; i++) {
    if (sorted[i + 9]! - sorted[i]! <= 60 * 60000) return true; // 10 within 60 min
  }
  return false;
}

/** All badge keys this rep has EARNED given their full knock history. The
 *  caller diffs against already-unlocked and inserts the new ones. */
export function evaluateAchievements({ knocks, tz }: AchievementInput): string[] {
  const earned: string[] = [];
  const doors = knocks.length;
  const sales = knocks.filter((k) => k.outcome === "sale");
  const times = knocks.map((k) => k.at);

  if (sales.length > 0) earned.push("first_sale");
  if (doors >= 100) earned.push("doors_100");
  if (doors >= 1000) earned.push("doors_1000");
  if (hotHand(times.map((t) => t.getTime()))) earned.push("hot_hand");

  const streak = bestStreak(times, tz);
  if (streak >= 5) earned.push("streak_5");
  if (streak >= 10) earned.push("streak_10");
  if (streak >= 30) earned.push("streak_30");

  // rainmaker: >= $25k sales in any single local day
  const byDay = new Map<string, number>();
  for (const s of sales) {
    const key = dateKeyInTimeZone(s.at, tz);
    byDay.set(key, (byDay.get(key) ?? 0) + (s.amount ?? 0));
  }
  if ([...byDay.values()].some((v) => v >= 25000)) earned.push("rainmaker");

  // early_bird: any knock before 8am local
  if (times.some((t) => hourInTimeZone(t, tz) < 8)) earned.push("early_bird");

  return earned;
}
