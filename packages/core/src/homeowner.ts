import { z } from "./schemas";
import { JOB_STAGE, type JobStage } from "./enums";
import { type QuietHours, nextAllowedSendTime } from "./quiet-hours";
import { instantAtLocalHourOnDayOf } from "./tz";

const NOTIFY_DEFAULT: JobStage[] = ["approved", "production", "complete"];

// Default homeowner quiet window: 9pm → 8am local (no SMS lands overnight — TCPA-safe).
const QUIET_DEFAULT: QuietHours = { startHour: 21, endHour: 8 };

// Default copy for the two crew-day touches. Editable per tenant via settings.homeowner.crewJourney.
const EVE_BEFORE_COPY_DEFAULT =
  "Your roofing crew arrives tomorrow! Quick prep so we can get right to work: please move cars out of the driveway, keep pets indoors, and clear access to your attic. Questions? Just reply.";
const DAY_OF_COPY_DEFAULT =
  "Good morning! Your roofing crew is on the way today. We'll keep you posted as the work progresses — thanks for trusting us with your home.";
const MID_DAY_COPY_DEFAULT =
  "Quick update — your roof is well underway and the crew is making great progress. We'll let you know as soon as it's wrapped up.";
const DELIVERY_EVE_COPY_DEFAULT =
  "Heads up — your roofing materials are scheduled to arrive tomorrow. They'll be dropped in the driveway; no need to be home. Please keep the driveway clear if you can.";

const quietHoursSchema = z
  .object({ startHour: z.number().int().min(0).max(23), endHour: z.number().int().min(0).max(23) })
  .default(QUIET_DEFAULT);

const crewJourneySchema = z
  .object({
    eveBeforeHour: z.number().int().min(0).max(23).default(18),
    dayOfHour: z.number().int().min(0).max(23).default(7),
    midDayHour: z.number().int().min(0).max(23).default(12),
    deliveryEveHour: z.number().int().min(0).max(23).default(18),
    eveBeforeCopy: z.string().min(1).default(EVE_BEFORE_COPY_DEFAULT),
    dayOfCopy: z.string().min(1).default(DAY_OF_COPY_DEFAULT),
    midDayCopy: z.string().min(1).default(MID_DAY_COPY_DEFAULT),
    deliveryEveCopy: z.string().min(1).default(DELIVERY_EVE_COPY_DEFAULT),
  })
  .default({});

const homeownerSchema = z.object({
  enabled: z.boolean().default(true),
  notifyStages: z.array(z.string()).default(NOTIFY_DEFAULT)
    .transform((a) => a.filter((s): s is JobStage => (JOB_STAGE as readonly string[]).includes(s))),
  quietHours: quietHoursSchema,
  crewJourney: crewJourneySchema,
});
export type HomeownerConfig = {
  enabled: boolean;
  notifyStages: JobStage[];
  quietHours: QuietHours;
  crewJourney: {
    eveBeforeHour: number; dayOfHour: number; midDayHour: number; deliveryEveHour: number;
    eveBeforeCopy: string; dayOfCopy: string; midDayCopy: string; deliveryEveCopy: string;
  };
};
export function parseHomeownerConfig(raw: unknown): HomeownerConfig {
  return homeownerSchema.parse(raw ?? {}) as HomeownerConfig;
}

export type CrewDayTouch = { key: "eve_before" | "day_of" | "mid_day"; fireAt: Date; body: string };

/**
 * The homeowner's crew-day journey off a scheduled install (§F): an evening-before
 * prep text (cars out, pets in, attic access) and a day-of-morning heads-up. Each
 * touch fires at its configured LOCAL wall-clock hour, pushed out of quiet hours,
 * and any touch whose time has already passed (e.g. a same-day booking) is dropped.
 * Pure — the Inngest wrapper handles the durable sleep + send.
 */
export function buildCrewDayTouches(installStartsAt: Date, tz: string, cfg: HomeownerConfig, now: Date): CrewDayTouch[] {
  const { eveBeforeHour, dayOfHour, midDayHour, eveBeforeCopy, dayOfCopy, midDayCopy } = cfg.crewJourney;
  const priorDayAnchor = new Date(installStartsAt.getTime() - 24 * 3_600_000);
  const touches: CrewDayTouch[] = [
    { key: "eve_before", fireAt: nextAllowedSendTime(instantAtLocalHourOnDayOf(priorDayAnchor, tz, eveBeforeHour), tz, cfg.quietHours), body: eveBeforeCopy },
    { key: "day_of", fireAt: nextAllowedSendTime(instantAtLocalHourOnDayOf(installStartsAt, tz, dayOfHour), tz, cfg.quietHours), body: dayOfCopy },
    { key: "mid_day", fireAt: nextAllowedSendTime(instantAtLocalHourOnDayOf(installStartsAt, tz, midDayHour), tz, cfg.quietHours), body: midDayCopy },
  ];
  return touches.filter((t) => t.fireAt.getTime() > now.getTime()).sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime());
}

/**
 * The evening-before-DELIVERY homeowner text (§F): "materials arrive tomorrow." Fires at
 * `crewJourney.deliveryEveHour` tenant-local the evening before the material-order delivery
 * date, pushed out of quiet hours. Returns null when there is no delivery date or the evening
 * before has already passed. Pure — the Inngest wrapper handles the durable sleep + send.
 */
export function buildDeliveryEveTouch(
  deliveryAt: Date | null,
  tz: string,
  cfg: HomeownerConfig,
  now: Date,
): { fireAt: Date; body: string } | null {
  if (!deliveryAt) return null;
  const priorDayAnchor = new Date(deliveryAt.getTime() - 24 * 3_600_000);
  const fireAt = nextAllowedSendTime(instantAtLocalHourOnDayOf(priorDayAnchor, tz, cfg.crewJourney.deliveryEveHour), tz, cfg.quietHours);
  if (fireAt.getTime() <= now.getTime()) return null;
  return { fireAt, body: cfg.crewJourney.deliveryEveCopy };
}

/** Customer-friendly milestone copy for notifications + the status page. */
export function homeownerStageCopy(stage: JobStage): { headline: string; body: string } {
  const map: Record<JobStage, { headline: string; body: string }> = {
    lead: { headline: "We've got your info", body: "Thanks for reaching out! We'll be in touch to schedule your inspection." },
    inspected: { headline: "Inspection complete", body: "Your roof inspection is done — we're preparing your estimate." },
    estimate: { headline: "Your estimate is ready", body: "We've put together your estimate and will walk you through it." },
    approved: { headline: "You're approved! 🎉", body: "Your project is approved — we're getting it on the schedule." },
    production: { headline: "Installation underway", body: "Good news — work on your new roof is underway." },
    closeout: { headline: "Finishing up", body: "We're wrapping up the final details on your roof." },
    billing: { headline: "Almost done", body: "Your project is complete — final paperwork is on the way." },
    complete: { headline: "All done! 🏠", body: "Your project is complete. Thank you for trusting us with your home!" },
    lost: { headline: "Project on hold", body: "This project isn't moving forward right now. Reach out anytime if that changes." },
  };
  return map[stage];
}

const MILESTONES: { key: JobStage; label: string }[] = [
  { key: "inspected", label: "Inspection" },
  { key: "estimate", label: "Estimate" },
  { key: "approved", label: "Approved" },
  { key: "production", label: "Installation" },
  { key: "closeout", label: "Finishing up" },
  { key: "complete", label: "Complete" },
];

/** The homeowner-facing journey: each milestone marked done/current/upcoming vs the current stage. */
export function buildHomeownerJourney(currentStage: JobStage): Array<{ key: JobStage; label: string; status: "done" | "current" | "upcoming" }> {
  const cur = JOB_STAGE.indexOf(currentStage);
  return MILESTONES.map((m) => {
    const mi = JOB_STAGE.indexOf(m.key);
    const status = mi < cur ? "done" : mi === cur ? "current" : "upcoming";
    return { key: m.key, label: m.label, status };
  });
}
