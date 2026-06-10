import { test, expect } from "vitest";
import { makeFakeCalendarSync } from "./gcal";

test("fake calendar records create/patch/delete calls", async () => {
  const fake = makeFakeCalendarSync();
  const { eventId } = await fake.createEvent({ connectionId: "c1", summary: "Inspection", startsAt: new Date(), endsAt: new Date() });
  expect(eventId).toMatch(/^fake-/);
  await fake.patchEvent({ connectionId: "c1", eventId, startsAt: new Date(), endsAt: new Date() });
  await fake.deleteEvent({ connectionId: "c1", eventId });
  expect(fake.calls.map((c) => c.op)).toEqual(["create", "patch", "delete"]);
});
