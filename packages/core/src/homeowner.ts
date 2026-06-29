import { z } from "./schemas";
import { JOB_STAGE, type JobStage } from "./enums";

const NOTIFY_DEFAULT: JobStage[] = ["approved", "production", "complete"];

const homeownerSchema = z.object({
  enabled: z.boolean().default(true),
  notifyStages: z.array(z.string()).default(NOTIFY_DEFAULT)
    .transform((a) => a.filter((s): s is JobStage => (JOB_STAGE as readonly string[]).includes(s))),
});
export type HomeownerConfig = { enabled: boolean; notifyStages: JobStage[] };
export function parseHomeownerConfig(raw: unknown): HomeownerConfig {
  return homeownerSchema.parse(raw ?? {}) as HomeownerConfig;
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
