import { z } from "./schemas";

export type SpeedToLeadConfig = { firstTouchSlaMin: number; escalateMin: number };
export type CadenceTouch = { dayOffset: number; hourOffset: number; channel: "sms" | "email" };
export type LeadCadenceConfig = { steps: CadenceTouch[]; quietHours: { startHour: number; endHour: number } };

// The intake ack SMS owns t=0 (Day-0 touch #1); the cadence covers the rest.
// "Day 0×2" = ack (t=0) + the +4h email below; no duplicate t=0 SMS.
export const DEFAULT_CADENCE: CadenceTouch[] = [
  { dayOffset: 0, hourOffset: 4, channel: "email" },
  { dayOffset: 1, hourOffset: 0, channel: "sms" },
  { dayOffset: 3, hourOffset: 0, channel: "email" },
  { dayOffset: 5, hourOffset: 0, channel: "sms" },
  { dayOffset: 7, hourOffset: 0, channel: "email" },
  { dayOffset: 14, hourOffset: 0, channel: "sms" },
];

const speedSchema = z.object({
  firstTouchSlaMin: z.number().positive().default(3),
  escalateMin: z.number().positive().default(10),
});
export function parseSpeedToLeadConfig(raw: unknown): SpeedToLeadConfig {
  return speedSchema.parse(raw ?? {});
}

const touchSchema = z.object({
  dayOffset: z.number().int().min(0),
  hourOffset: z.number().int().min(0).default(0),
  channel: z.enum(["sms", "email"]),
});
const cadenceSchema = z.object({
  steps: z.array(touchSchema).default([...DEFAULT_CADENCE]),
  quietHours: z
    .object({ startHour: z.number().int().min(0).max(23), endHour: z.number().int().min(0).max(23) })
    .default({ startHour: 21, endHour: 8 }),
});
export function parseLeadCadenceConfig(raw: unknown): LeadCadenceConfig {
  const p = cadenceSchema.parse(raw ?? {});
  return { steps: p.steps.length ? p.steps : [...DEFAULT_CADENCE], quietHours: p.quietHours };
}

// Consent + opt-out gate for a proactive send. SMS needs recorded consent; email needs only no-opt-out.
export function shouldSendChannel(
  channel: "sms" | "email",
  c: { smsOptOut: boolean; emailOptOut: boolean; smsConsentAt: Date | null },
): boolean {
  if (channel === "sms") return !c.smsOptOut && c.smsConsentAt != null;
  return !c.emailOptOut;
}
