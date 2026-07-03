import { z } from "./schemas";
import type { QuietHours } from "./quiet-hours";

export type RetailTouch = { dayOffset: number; channel: "sms" | "email" };

/** The retail close-out follow-up cadence: 7/15/30/60/90 days post-invoice. */
export const DEFAULT_RETAIL_STEPS: RetailTouch[] = [
  { dayOffset: 7, channel: "sms" },
  { dayOffset: 15, channel: "email" },
  { dayOffset: 30, channel: "sms" },
  { dayOffset: 60, channel: "email" },
  { dayOffset: 90, channel: "email" },
];

const BALANCE_REMINDER_DEFAULT = "Just a friendly reminder that a balance remains on your completed roofing project.";
const REVIEW_ASK_DEFAULT = "Happy with your new roof? A quick review means the world to us — and referrals are the biggest compliment:";

export type RetailCadenceConfig = {
  enabled: boolean;
  steps: RetailTouch[];
  quietHours: QuietHours;
  reviewUrl: string; // where the review ask points; "" falls back to the status page
  copy: { balanceReminder: string; reviewAsk: string };
};

const touchSchema = z.object({
  dayOffset: z.number().int().min(0),
  channel: z.enum(["sms", "email"]),
});

const schema = z.object({
  enabled: z.boolean().default(true),
  steps: z.array(touchSchema).default([...DEFAULT_RETAIL_STEPS]),
  quietHours: z
    .object({ startHour: z.number().int().min(0).max(23), endHour: z.number().int().min(0).max(23) })
    .default({ startHour: 21, endHour: 8 }),
  reviewUrl: z.string().default(""),
  copy: z
    .object({
      balanceReminder: z.string().min(1).default(BALANCE_REMINDER_DEFAULT),
      reviewAsk: z.string().min(1).default(REVIEW_ASK_DEFAULT),
    })
    .default({}),
});

export function parseRetailCadenceConfig(raw: unknown): RetailCadenceConfig {
  const p = schema.parse(raw ?? {});
  return { ...p, steps: p.steps.length ? p.steps : [...DEFAULT_RETAIL_STEPS] };
}

function formatUsd(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * The message for one retail cadence touch. When a balance is open it leads with a
 * gentle balance nudge + pay link, then the review/referral ask; once settled it is
 * purely the review/referral ask. (Hard overdue collection is dunning's job — this
 * is the softer relationship layer.)
 */
export function buildRetailTouchBody(opts: {
  balanceCents: number;
  payLink: string;
  reviewLink: string;
  copy: { balanceReminder: string; reviewAsk: string };
}): string {
  const parts: string[] = [];
  if (opts.balanceCents > 0) {
    parts.push(`${opts.copy.balanceReminder} Balance: ${formatUsd(opts.balanceCents)}. Pay securely: ${opts.payLink}`);
  }
  parts.push(`${opts.copy.reviewAsk} ${opts.reviewLink}`);
  return parts.join(" ");
}
