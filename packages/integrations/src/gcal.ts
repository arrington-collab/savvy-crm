import { nangoProxy } from "./nango";

export interface CalendarSync {
  createEvent(o: { connectionId: string; summary: string; description?: string; startsAt: Date; endsAt: Date }): Promise<{ eventId: string }>;
  patchEvent(o: { connectionId: string; eventId: string; summary?: string; startsAt: Date; endsAt: Date }): Promise<void>;
  deleteEvent(o: { connectionId: string; eventId: string }): Promise<void>;
}

// Real impl talks to Google Calendar through Nango's proxy. Kept thin; the
// connectionId is the per-user Nango connection (stored on user.gcalConnectionId).
export const nangoGcal: CalendarSync = {
  async createEvent({ connectionId, summary, description, startsAt, endsAt }) {
    const res = await nangoProxy({
      connectionId,
      integrationId: process.env.NANGO_GCAL_INTEGRATION_ID ?? "google-calendar",
      method: "POST",
      endpoint: "/calendar/v3/calendars/primary/events",
      body: { summary, description, start: { dateTime: startsAt.toISOString() }, end: { dateTime: endsAt.toISOString() } },
    });
    return { eventId: (res as { id: string }).id };
  },
  async patchEvent({ connectionId, eventId, summary, startsAt, endsAt }) {
    await nangoProxy({
      connectionId,
      integrationId: process.env.NANGO_GCAL_INTEGRATION_ID ?? "google-calendar",
      method: "PATCH",
      endpoint: `/calendar/v3/calendars/primary/events/${eventId}`,
      body: { ...(summary ? { summary } : {}), start: { dateTime: startsAt.toISOString() }, end: { dateTime: endsAt.toISOString() } },
    });
  },
  async deleteEvent({ connectionId, eventId }) {
    await nangoProxy({
      connectionId,
      integrationId: process.env.NANGO_GCAL_INTEGRATION_ID ?? "google-calendar",
      method: "DELETE",
      endpoint: `/calendar/v3/calendars/primary/events/${eventId}`,
    });
  },
};

export function makeFakeCalendarSync(): CalendarSync & { calls: { op: string; eventId?: string }[] } {
  const calls: { op: string; eventId?: string }[] = [];
  let n = 0;
  return {
    calls,
    async createEvent() { const eventId = `fake-${++n}`; calls.push({ op: "create", eventId }); return { eventId }; },
    async patchEvent({ eventId }) { calls.push({ op: "patch", eventId }); },
    async deleteEvent({ eventId }) { calls.push({ op: "delete", eventId }); },
  };
}
