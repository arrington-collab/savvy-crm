import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminDb, withTenant, tenant, communication, eq } from "@savvy/db";

const { id: tenantId } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string; key: string };

// Verifies the Twilio voice path captures call duration for AI-voice-minute
// metering: the <Record> action callback creates the call communication; the
// status callback at recording-end fills durationSeconds (matched by CallSid),
// without producing a duplicate row.
test("voice: status callback fills call duration onto the metered communication", async ({ request }) => {
  const [t] = await adminDb.select().from(tenant).where(eq(tenant.id, tenantId));
  const inbound = t!.inboundPhone!;
  const from = "+15558675309";
  const callSid = `CA${randomUUID().replace(/-/g, "")}`;

  // 1) Recording action callback -> inserts the channel=call row, no duration yet.
  const rec = await request.post(`/api/twilio/voice?event=recording`, {
    form: { To: inbound, From: from, CallSid: callSid, RecordingUrl: "https://api.twilio.test/r1" },
  });
  expect(rec.ok()).toBeTruthy();

  const before = await withTenant(tenantId, (tx) =>
    tx.select().from(communication).where(eq(communication.twilioSid, callSid)));
  expect(before.length).toBe(1);
  expect(before[0]!.channel).toBe("call");
  expect(before[0]!.durationSeconds).toBeNull();

  // 2) Status callback at recording-end -> fills duration, no duplicate row.
  const status = await request.post(`/api/twilio/voice?event=status`, {
    form: { To: inbound, CallSid: callSid, RecordingStatus: "completed", RecordingDuration: "137" },
  });
  expect(status.ok()).toBeTruthy();

  const after = await withTenant(tenantId, (tx) =>
    tx.select().from(communication).where(eq(communication.twilioSid, callSid)));
  expect(after.length).toBe(1);
  expect(after[0]!.durationSeconds).toBe(137);
});
