import { withTenant, eq, appointment, user as userTbl } from "@savvy/db";
import { nangoGcal, type CalendarSync } from "@savvy/integrations";
import { inngest } from "../client";

type ApptLite = { id: string; gcalEventId: string | null; type: string; startsAt: Date; endsAt: Date; status: string };

export async function syncCalendarForAppointment(
  input:
    | { event: "appointment/booked"; appt: ApptLite; connectionId: string | null }
    | { event: "appointment/changed"; reason: "rescheduled" | "reassigned" | "canceled" | "done" | "no_show"; appt: ApptLite; connectionId: string | null },
  deps: { cal: CalendarSync },
): Promise<{ op: "created" | "patched" | "deleted" | "skipped"; eventId?: string }> {
  const { appt, connectionId } = input;
  if (!connectionId) return { op: "skipped" };
  const summary = `${appt.type} appointment`;

  if (input.event === "appointment/changed" && (input.reason === "canceled" || input.reason === "no_show" || input.reason === "done")) {
    if (!appt.gcalEventId) return { op: "skipped" };
    await deps.cal.deleteEvent({ connectionId, eventId: appt.gcalEventId });
    return { op: "deleted" };
  }
  if (appt.gcalEventId) {
    await deps.cal.patchEvent({ connectionId, eventId: appt.gcalEventId, summary, startsAt: appt.startsAt, endsAt: appt.endsAt });
    return { op: "patched", eventId: appt.gcalEventId };
  }
  const { eventId } = await deps.cal.createEvent({ connectionId, summary, startsAt: appt.startsAt, endsAt: appt.endsAt });
  return { op: "created", eventId };
}

export const appointmentCalendarSync = inngest.createFunction(
  { id: "appointment-calendar-sync", concurrency: { limit: 5 } },
  [{ event: "appointment/booked" }, { event: "appointment/changed" }],
  async ({ event, step }) => {
    const { appointmentId, tenantId } = event.data as { appointmentId: string; tenantId: string };
    const loaded = await step.run("load", () => withTenant(tenantId, async (tx) => {
      const [a] = await tx.select().from(appointment).where(eq(appointment.id, appointmentId));
      if (!a) return null;
      const [u] = a.assigneeUserId ? await tx.select().from(userTbl).where(eq(userTbl.id, a.assigneeUserId)) : [undefined];
      return { appt: { id: a.id, gcalEventId: a.gcalEventId, type: a.type, startsAt: a.startsAt, endsAt: a.endsAt, status: a.status }, connectionId: u?.gcalConnectionId ?? null };
    }));
    if (!loaded) return { skipped: true };

    // step.run serialises return values as JSON, converting Date → string.
    // Re-hydrate before passing to syncCalendarForAppointment.
    const apptHydrated = {
      ...loaded.appt,
      startsAt: new Date(loaded.appt.startsAt as unknown as string),
      endsAt: new Date(loaded.appt.endsAt as unknown as string),
    };

    const result = await step.run("sync", () =>
      syncCalendarForAppointment(
        event.name === "appointment/booked"
          ? { event: "appointment/booked", appt: apptHydrated, connectionId: loaded.connectionId }
          : { event: "appointment/changed", reason: (event.data as { reason: "rescheduled" | "reassigned" | "canceled" | "done" | "no_show" }).reason, appt: apptHydrated, connectionId: loaded.connectionId },
        { cal: nangoGcal },
      ),
    );

    if (result.op === "created" && result.eventId) {
      await step.run("store-event-id", () => withTenant(tenantId, (tx) =>
        tx.update(appointment).set({ gcalEventId: result.eventId! }).where(eq(appointment.id, appointmentId))));
    }
    return result;
  },
);
