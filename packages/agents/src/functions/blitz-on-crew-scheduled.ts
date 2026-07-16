import { adminDb, appointment, buildMobilizationBlitz, eq } from "@savvy/db";
import { inngest } from "../client";

/**
 * Phase 26 slice 1: production scheduled ⇒ blitz plan. Listens to the same
 * appointment/booked event the calendar sync uses; only crew installs
 * qualify. buildMobilizationBlitz is idempotent per job, so re-books and
 * reschedules never double-plan. Pieces hold print_pending (dormant seam).
 */
export const blitzOnCrewScheduled = inngest.createFunction(
  { id: "blitz-on-crew-scheduled" },
  { event: "appointment/booked" },
  async ({ event, step }) => {
    const result = await step.run("plan", async () => {
      const [appt] = await adminDb.select({ type: appointment.type, jobId: appointment.jobId, tenantId: appointment.tenantId })
        .from(appointment).where(eq(appointment.id, event.data.appointmentId));
      if (!appt || appt.type !== "crew" || !appt.jobId) return { skipped: "not_crew_install" as const };
      return buildMobilizationBlitz(appt.tenantId, { jobId: appt.jobId });
    });
    return result;
  },
);
