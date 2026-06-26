import { describe, it, expect, beforeAll } from "vitest";
import { recordVoiceCallReport } from "./voice";
import { adminDb, withTenant, tenant, customer, property, lead, communication, eq } from "../index";

let tenantId: string;
let leadId: string;

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({ name: "Voice Co", publicKey: `voice-${Date.now()}` }).returning();
  tenantId = t!.id;
  await withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name: "Caller", phone: "+16025551111" }).returning();
    const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: "2 Main" }).returning();
    const [l] = await tx.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, status: "new" }).returning();
    leadId = l!.id;
  });
});

describe("recordVoiceCallReport", () => {
  it("logs a call communication and sets lead.voice_outcome", async () => {
    await recordVoiceCallReport({
      tenantId, leadId, direction: "inbound",
      transcript: "AI: hello\nCaller: book me", recordingUrl: "https://rec/1",
      durationSeconds: 42, providerCallId: "vapi-1", outcome: "booked",
    });

    const [comm] = await adminDb.select().from(communication).where(eq(communication.tenantId, tenantId));
    expect(comm).toMatchObject({ channel: "call", direction: "inbound", transcript: "AI: hello\nCaller: book me", recordingUrl: "https://rec/1", durationSeconds: 42, twilioSid: "vapi-1", aiHandled: true });

    const [l] = await adminDb.select({ vo: lead.voiceOutcome }).from(lead).where(eq(lead.id, leadId));
    expect(l!.vo).toBe("booked");
  });

  it("tolerates a null outcome (logs the call, leaves voice_outcome null)", async () => {
    await recordVoiceCallReport({
      tenantId, leadId, direction: "outbound",
      transcript: null, recordingUrl: null, durationSeconds: null, providerCallId: "vapi-2", outcome: null,
    });
    const comms = await adminDb.select().from(communication).where(eq(communication.tenantId, tenantId));
    expect(comms.length).toBeGreaterThanOrEqual(2);
  });
});
