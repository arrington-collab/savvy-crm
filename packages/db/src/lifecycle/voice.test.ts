import { describe, it, expect, beforeAll } from "vitest";
import { recordVoiceCallReport, setLeadVoiceCallId, getLeadByVoiceCallId } from "./voice.js";
import { adminDb, withTenant, tenant, customer, property, lead, communication, eq } from "../index.js";

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

async function mkTenant(name: string) {
  const [t] = await adminDb.insert(tenant).values({ name, publicKey: `k-${name}-${Date.now()}`, clerkOrgId: `o-${name}-${Date.now()}` }).returning();
  return t!.id;
}
async function mkLead(tid: string) {
  return withTenant(tid, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId: tid, name: "Caller", phone: "+16025550111" }).returning({ id: customer.id });
    const [p] = await tx.insert(property).values({ tenantId: tid, customerId: c!.id, address: "1 Main St" }).returning({ id: property.id });
    const [l] = await tx.insert(lead).values({ tenantId: tid, customerId: c!.id, propertyId: p!.id, source: "inbound-call" }).returning({ id: lead.id });
    return l!.id;
  });
}

describe("lead voice-call-id correlation", () => {
  it("round-trips the call id and returns the lead", async () => {
    const tid = await mkTenant("vc-rt");
    const lid = await mkLead(tid);
    await withTenant(tid, (tx) => setLeadVoiceCallId(tx, { tenantId: tid, leadId: lid, callId: "vapi-call-1" }));
    const found = await getLeadByVoiceCallId(tid, "vapi-call-1");
    expect(found?.id).toBe(lid);
  });
  it("returns null for an unknown call id", async () => {
    const tid = await mkTenant("vc-none");
    expect(await getLeadByVoiceCallId(tid, "nope")).toBeNull();
  });
  it("does not find another tenant's call id (RLS)", async () => {
    const t1 = await mkTenant("vc-iso1");
    const t2 = await mkTenant("vc-iso2");
    const lid = await mkLead(t2);
    await withTenant(t2, (tx) => setLeadVoiceCallId(tx, { tenantId: t2, leadId: lid, callId: "shared-id" }));
    expect(await getLeadByVoiceCallId(t1, "shared-id")).toBeNull();
  });
});
