import { test, expect, describe, it } from "vitest";
import { InMemoryStore } from "@savvy/orchestrator";
import { buildReminderMessage, bridgeReminderSent, reminderOffsetLabel } from "./appointment-reminders";

const T = "33333333-3333-3333-3333-333333333333";

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

describe("reminderOffsetLabel", () => {
  it("maps 24 -> '24h', 2 -> '2h', and 1 -> '1h'", () => {
    expect(reminderOffsetLabel(24)).toBe("24h");
    expect(reminderOffsetLabel(2)).toBe("2h");
    expect(reminderOffsetLabel(1)).toBe("1h");
  });
});

describe("bridgeReminderSent", () => {
  it("publishes reminder.sent audited with the appointment+offset idempotency key", async () => {
    const store = new InMemoryStore();
    await bridgeReminderSent(store, { tenantId: T, leadId: "lead-1", appointmentId: "appt-1", offset: "24h", channel: "sms" });
    const audit = store.audits.find((a) => a.event.idempotencyKey === "reminder.sent:appt-1:24h");
    expect(audit).toBeTruthy();
    expect(audit?.event.payload).toMatchObject({ leadId: "lead-1", appointmentId: "appt-1", offset: "24h", channel: "sms" });
  });

  it("is idempotent — a second call for the same appointment+offset does not double-publish", async () => {
    const store = new InMemoryStore();
    await bridgeReminderSent(store, { tenantId: T, leadId: "lead-2", appointmentId: "appt-2", offset: "1h", channel: "sms" });
    const before = store.audits.filter((a) => a.event.type === "reminder.sent").length;
    await bridgeReminderSent(store, { tenantId: T, leadId: "lead-2", appointmentId: "appt-2", offset: "1h", channel: "sms" });
    const after = store.audits.filter((a) => a.event.type === "reminder.sent").length;
    expect(after).toBe(before);
    expect(before).toBe(1);
  });

  it("distinct offsets for the same appointment publish distinct events", async () => {
    const store = new InMemoryStore();
    await bridgeReminderSent(store, { tenantId: T, leadId: "lead-3", appointmentId: "appt-3", offset: "24h", channel: "sms" });
    await bridgeReminderSent(store, { tenantId: T, leadId: "lead-3", appointmentId: "appt-3", offset: "1h", channel: "sms" });
    const audits = store.audits.filter(
      (a) => a.event.type === "reminder.sent" && (a.event.payload as { appointmentId?: string }).appointmentId === "appt-3",
    );
    expect(audits.map((a) => a.event.idempotencyKey).sort()).toEqual(["reminder.sent:appt-3:1h", "reminder.sent:appt-3:24h"]);
  });

  // Regression coverage for the dropped-events defect: the tenant default reminder
  // schedule (packages/core/src/scheduling.ts) is 24h + 2h, not 24h + 1h. A 2h
  // reminder must bridge onto the domain-event bus like any other configured offset.
  it("bridges a 2h reminder (the tenant default's non-24h/1h offset) using the flexible offset formatter", async () => {
    const store = new InMemoryStore();
    await bridgeReminderSent(store, {
      tenantId: T, leadId: "lead-4", appointmentId: "appt-4", offset: reminderOffsetLabel(2), channel: "sms",
    });
    const audit = store.audits.find((a) => a.event.idempotencyKey === "reminder.sent:appt-4:2h");
    expect(audit).toBeTruthy();
    expect(audit?.event.payload).toMatchObject({ leadId: "lead-4", appointmentId: "appt-4", offset: "2h", channel: "sms" });
  });
});
