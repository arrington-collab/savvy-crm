import { describe, it, expect } from "vitest";
import { setCallDuration } from "../src/lifecycle/voice.js";
import { adminDb } from "../src/admin-client.js";
import { withTenant } from "../src/tenant.js";
import { communication } from "../src/schema/index.js";
import { eq } from "drizzle-orm";
import { makeTenant } from "./helpers.js";

describe("setCallDuration", () => {
  it("fills durationSeconds on the call communication matching the twilio sid", async () => {
    const { tenantId } = await makeTenant();
    const sid = `CA-${crypto.randomUUID()}`;
    // The recording-action callback inserts the call row with the sid but no duration yet.
    await adminDb.insert(communication).values({
      tenantId, channel: "call", direction: "inbound", twilioSid: sid, aiHandled: true,
    });

    // The status callback at call-end delivers the final duration.
    await setCallDuration(tenantId, sid, 137);

    const [row] = await withTenant(tenantId, (tx) =>
      tx.select().from(communication).where(eq(communication.twilioSid, sid)));
    expect(row!.durationSeconds).toBe(137);
  });

  it("only updates the matching sid, leaving other calls untouched", async () => {
    const { tenantId } = await makeTenant();
    const sidA = `CA-${crypto.randomUUID()}`;
    const sidB = `CA-${crypto.randomUUID()}`;
    await adminDb.insert(communication).values({ tenantId, channel: "call", direction: "inbound", twilioSid: sidA });
    await adminDb.insert(communication).values({ tenantId, channel: "call", direction: "inbound", twilioSid: sidB });

    await setCallDuration(tenantId, sidA, 60);

    const rows = await withTenant(tenantId, (tx) =>
      tx.select().from(communication).where(eq(communication.tenantId, tenantId)));
    expect(rows.find((r) => r.twilioSid === sidA)!.durationSeconds).toBe(60);
    expect(rows.find((r) => r.twilioSid === sidB)!.durationSeconds).toBeNull();
  });
});
