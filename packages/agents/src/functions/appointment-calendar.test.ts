import { test, expect } from "vitest";
import { syncCalendarForAppointment } from "./appointment-calendar";
import { makeFakeCalendarSync } from "@savvy/integrations";

const baseAppt = { id: "a1", gcalEventId: null as string | null, type: "inspection", startsAt: new Date(), endsAt: new Date(), status: "scheduled" };

test("create when assignee connected and no existing event", async () => {
  const cal = makeFakeCalendarSync();
  const out = await syncCalendarForAppointment(
    { event: "appointment/booked", appt: baseAppt, connectionId: "c1" }, { cal },
  );
  expect(out).toEqual({ op: "created", eventId: "fake-1" });
  expect(cal.calls[0]!.op).toBe("create");
});

test("no-op when assignee has no connection", async () => {
  const cal = makeFakeCalendarSync();
  const out = await syncCalendarForAppointment(
    { event: "appointment/booked", appt: baseAppt, connectionId: null }, { cal },
  );
  expect(out).toEqual({ op: "skipped" });
  expect(cal.calls).toHaveLength(0);
});

test("changed->canceled deletes the event", async () => {
  const cal = makeFakeCalendarSync();
  const out = await syncCalendarForAppointment(
    { event: "appointment/changed", reason: "canceled", appt: { ...baseAppt, gcalEventId: "ev9", status: "canceled" }, connectionId: "c1" }, { cal },
  );
  expect(out).toEqual({ op: "deleted" });
  expect(cal.calls[0]!.op).toBe("delete");
});

test("changed->rescheduled patches existing, creates if missing", async () => {
  const cal = makeFakeCalendarSync();
  await syncCalendarForAppointment({ event: "appointment/changed", reason: "rescheduled", appt: { ...baseAppt, gcalEventId: "ev9" }, connectionId: "c1" }, { cal });
  expect(cal.calls[0]!.op).toBe("patch");
});
