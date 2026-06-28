import "server-only";
import { withTenant, appointment, repAvailabilityBlock, tenant, eq, and, gte, lt, listAssignableReps } from "@savvy/db";
import { parseSchedulingConfig, officeMinutesForWindow, overlapMinutes, buildCapacityView, toCivilDate, addDays, zonedTimeToUtc, type CapacityView } from "@savvy/core";
import { getTenantId } from "./tenant";
import { getTenantTimezone } from "./scheduling-queries";

const WINDOW_DAYS = 7;

export async function getCapacityView(): Promise<CapacityView> {
  const tenantId = await getTenantId();
  const tz = await getTenantTimezone();

  const today = toCivilDate(new Date().toISOString(), tz);
  const civilDates = Array.from({ length: WINDOW_DAYS }, (_, i) => addDays(today, i));
  const windowStart = new Date(zonedTimeToUtc(today, 0, tz));
  const windowEnd = new Date(zonedTimeToUtc(addDays(today, WINDOW_DAYS), 0, tz));

  return withTenant(tenantId, async (tx) => {
    const [t] = await tx.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
    const config = parseSchedulingConfig((t?.settings as { scheduling?: unknown } | undefined)?.scheduling);
    const officeMinutesInWindow = officeMinutesForWindow(config, civilDates);

    const reps = await listAssignableReps(tenantId); // [{ id, name }]

    const appts = await tx
      .select({ assigneeUserId: appointment.assigneeUserId, startsAt: appointment.startsAt, endsAt: appointment.endsAt })
      .from(appointment)
      .where(and(eq(appointment.status, "scheduled"), gte(appointment.startsAt, windowStart), lt(appointment.startsAt, windowEnd)));

    const blocks = await tx
      .select({ userId: repAvailabilityBlock.userId, startsAt: repAvailabilityBlock.startsAt, endsAt: repAvailabilityBlock.endsAt })
      .from(repAvailabilityBlock)
      .where(and(lt(repAvailabilityBlock.startsAt, windowEnd), gte(repAvailabilityBlock.endsAt, windowStart)));

    const repInputs = reps.map((r) => {
      const mine = appts.filter((a) => a.assigneeUserId === r.id);
      // Booked = full appointment duration, intentionally counted even if the appt
      // runs outside office hours (see spec [ASSUMED] — overbooked-beyond-capacity
      // is a real signal). Available is office-minutes only, so utilization can exceed 100%.
      const scheduledMin = mine.reduce((s, a) => s + Math.round((a.endsAt.getTime() - a.startsAt.getTime()) / 60000), 0);
      const blockedMin = blocks
        .filter((b) => b.userId === r.id)
        .reduce((s, b) => s + overlapMinutes(b.startsAt, b.endsAt, windowStart, windowEnd), 0);
      return { userId: r.id, name: r.name, scheduledMin, blockedMin, apptCount: mine.length };
    });

    return buildCapacityView({ officeMinutesInWindow, windowDays: WINDOW_DAYS, reps: repInputs });
  });
}
