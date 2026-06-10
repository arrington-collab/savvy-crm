export interface CalendarSync {
  createEvent(o: { connectionId: string; summary: string; description?: string; startsAt: Date; endsAt: Date }): Promise<{ eventId: string }>;
  patchEvent(o: { connectionId: string; eventId: string; summary?: string; startsAt: Date; endsAt: Date }): Promise<void>;
  deleteEvent(o: { connectionId: string; eventId: string }): Promise<void>;
}

// Real impl talks to Google Calendar through Nango's proxy. Kept thin; the
// connectionId is the per-user Nango connection (stored on user.gcalConnectionId).
export const nangoGcal: CalendarSync = {
  async createEvent({ connectionId, summary, description, startsAt, endsAt }) {
    const res = await nangoProxy(connectionId, "POST", "/calendar/v3/calendars/primary/events", {
      summary, description, start: { dateTime: startsAt.toISOString() }, end: { dateTime: endsAt.toISOString() },
    });
    return { eventId: (res as { id: string }).id };
  },
  async patchEvent({ connectionId, eventId, summary, startsAt, endsAt }) {
    await nangoProxy(connectionId, "PATCH", `/calendar/v3/calendars/primary/events/${eventId}`, {
      ...(summary ? { summary } : {}), start: { dateTime: startsAt.toISOString() }, end: { dateTime: endsAt.toISOString() },
    });
  },
  async deleteEvent({ connectionId, eventId }) {
    await nangoProxy(connectionId, "DELETE", `/calendar/v3/calendars/primary/events/${eventId}`);
  },
};

async function nangoProxy(connectionId: string, method: string, endpoint: string, body?: unknown): Promise<unknown> {
  const host = process.env.NANGO_HOST ?? "https://api.nango.dev";
  const integrationId = process.env.NANGO_GCAL_INTEGRATION_ID ?? "google-calendar";
  const res = await fetch(`${host}/proxy${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.NANGO_SECRET_KEY ?? ""}`,
      "Connection-Id": connectionId,
      "Provider-Config-Key": integrationId,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`nango proxy ${method} ${endpoint} -> ${res.status}`);
  return method === "DELETE" ? undefined : res.json();
}

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
