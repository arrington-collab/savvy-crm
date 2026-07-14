// Customer for Life slice 2: the standing cadence — warm, sparse, useful.
// Pure config + date math; scheduling goes through the governor (slice 1) and
// sending lives in the agents sweep. Content rule: every touch is gratitude,
// useful info, or a free offer — never a discount blast, never "just checking in".

import { z } from "./schemas";

export const RELATIONSHIP_HOLIDAYS = ["thanksgiving", "christmas", "new_year"] as const;
export type RelationshipHoliday = (typeof RELATIONSHIP_HOLIDAYS)[number];

export const DEFAULT_RELATIONSHIP_COPY = {
  checkin30d:
    "Hi {{firstName}} — it's been a month since we finished your roof. Settling in fine? Anything we'd fix for a friend, we fix free — just reply here.",
  roofiversary:
    "Hi {{firstName}} — your roof turns {{years}} today. Still watching the weather over it for you. Nothing needed — happy roofiversary!",
  holidayCard:
    "From our crew to your family — thank you for trusting us with the roof over your head. Wishing you a warm holiday from all of us.",
} as const;

export type RelationshipCadenceConfig = {
  enabled: boolean;
  holiday: RelationshipHoliday;
  copy: { checkin30d: string; roofiversary: string; holidayCard: string };
};

const schema = z.object({
  enabled: z.boolean().default(true),
  holiday: z.enum(RELATIONSHIP_HOLIDAYS).default("thanksgiving"),
  copy: z
    .object({
      checkin30d: z.string().min(1).default(DEFAULT_RELATIONSHIP_COPY.checkin30d),
      roofiversary: z.string().min(1).default(DEFAULT_RELATIONSHIP_COPY.roofiversary),
      holidayCard: z.string().min(1).default(DEFAULT_RELATIONSHIP_COPY.holidayCard),
    })
    .default({}),
});

export function parseRelationshipCadenceConfig(raw: unknown): RelationshipCadenceConfig {
  return schema.parse(raw ?? {});
}

function thanksgiving(year: number): Date {
  // 4th Thursday of November (UTC).
  const nov1 = new Date(Date.UTC(year, 10, 1));
  const firstThursday = 1 + ((4 - nov1.getUTCDay() + 7) % 7);
  return new Date(Date.UTC(year, 10, firstThursday + 21));
}

/** Next occurrence of the tenant's holiday strictly after `after` (UTC day math). */
export function nextHolidayDate(holiday: RelationshipHoliday, after: Date): Date {
  const candidates = (year: number): Date => {
    switch (holiday) {
      case "thanksgiving": return thanksgiving(year);
      case "christmas": return new Date(Date.UTC(year, 11, 25));
      case "new_year": return new Date(Date.UTC(year, 0, 1));
    }
  };
  const thisYear = candidates(after.getUTCFullYear());
  return thisYear > after ? thisYear : candidates(after.getUTCFullYear() + 1);
}

/** Completion anniversary N years out; a Feb 29 roof celebrates Feb 28 off-leap. */
export function roofiversaryDate(completedAt: Date, years: number): Date {
  const y = completedAt.getUTCFullYear() + years;
  const m = completedAt.getUTCMonth();
  let d = completedAt.getUTCDate();
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  if (d > daysInMonth) d = daysInMonth;
  return new Date(Date.UTC(y, m, d));
}
