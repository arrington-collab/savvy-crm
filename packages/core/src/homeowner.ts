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

const quietHoursSchema = z
  .object({ startHour: z.number().int().min(0).max(23), endHour: z.number().int().min(0).max(23) })
  .default(QUIET_DEFAULT);

const crewJourneySchema = z
  .object({
    eveBeforeHour: z.number().int().min(0).max(23).default(18),
    dayOfHour: z.number().int().min(0).max(23).default(7),
    eveBeforeCopy: z.string().min(1).default(EVE_BEFORE_COPY_DEFAULT),
    dayOfCopy: z.string().min(1).default(DAY_OF_COPY_DEFAULT),
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
  crewJourney: { eveBeforeHour: number; dayOfHour: number; eveBeforeCopy: string; dayOfCopy: string };
};
export function parseHomeownerConfig(raw: unknown): HomeownerConfig {
  return homeownerSchema.parse(raw ?? {}) as HomeownerConfig;
}

export type CrewDayTouch = { key: "eve_before" | "day_of"; fireAt: Date; body: string };

/**
 * The homeowner's crew-day journey off a scheduled install (§F): an evening-before
 * prep text (cars out, pets in, attic access) and a day-of-morning heads-up. Each
 * touch fires at its configured LOCAL wall-clock hour, pushed out of quiet hours,
 * and any touch whose time has already passed (e.g. a same-day booking) is dropped.
 * Pure — the Inngest wrapper handles the durable sleep + send.
 */
export function buildCrewDayTouches(installStartsAt: Date, tz: string, cfg: HomeownerConfig, now: Date): CrewDayTouch[] {
  const { eveBeforeHour, dayOfHour, eveBeforeCopy, dayOfCopy } = cfg.crewJourney;
  const priorDayAnchor = new Date(installStartsAt.getTime() - 24 * 3_600_000);
  const touches: CrewDayTouch[] = [
    { key: "eve_before", fireAt: nextAllowedSendTime(instantAtLocalHourOnDayOf(priorDayAnchor, tz, eveBeforeHour), tz, cfg.quietHours), body: eveBeforeCopy },
    { key: "day_of", fireAt: nextAllowedSendTime(instantAtLocalHourOnDayOf(installStartsAt, tz, dayOfHour), tz, cfg.quietHours), body: dayOfCopy },
  ];
  return touches.filter((t) => t.fireAt.getTime() > now.getTime()).sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime());
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
