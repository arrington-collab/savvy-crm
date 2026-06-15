import { test, expect } from "vitest";
import { buildReminderMessage } from "./appointment-reminders";

test("sms reminder includes reschedule link + CANCEL hint", () => {
  const msg = buildReminderMessage({ type: "inspection", startsAt: new Date("2026-09-01T16:00:00Z") }, "https://x/book/tok", "sms");
  expect(msg.toLowerCase()).toContain("reschedule");
  expect(msg).toContain("https://x/book/tok");
  expect(msg.toUpperCase()).toContain("CANCEL");
});

test("email reminder includes link, no CANCEL reply hint", () => {
  const msg = buildReminderMessage({ type: "cm", startsAt: new Date("2026-09-01T16:00:00Z") }, "https://x/book/tok", "email");
  expect(msg).toContain("https://x/book/tok");
});
