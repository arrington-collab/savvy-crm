import { describe, it, expect, vi, beforeEach } from "vitest";

// Mirrors apps/web/src/app/api/twilio/inbound/route.test.ts's mocking style.
// vi.mock factories are hoisted above imports, so the mock fns must be too.
const {
  tenantByPhoneMock, createLeadForTenantMock, sendMock,
  publishDomainEventMock, makeEventMock, DrizzleOrchestratorStoreMock,
} = vi.hoisted(() => ({
  tenantByPhoneMock: vi.fn(),
  createLeadForTenantMock: vi.fn(),
  sendMock: vi.fn(),
  publishDomainEventMock: vi.fn(),
  makeEventMock: vi.fn((input: unknown) => input),
  DrizzleOrchestratorStoreMock: vi.fn(function DrizzleOrchestratorStoreMock(this: unknown) {}),
}));

// Only tenantByPhone comes from the web intake wrapper — the DB-level
// createLeadForTenant is imported directly from @savvy/db (see route.ts):
// the web wrapper's createLeadForTenant emits lead/created, which would
// double-text the caller alongside C3's missed-call text-back.
vi.mock("@/lib/intake", () => ({
  tenantByPhone: tenantByPhoneMock,
}));
vi.mock("@savvy/db", () => ({
  createLeadForTenant: createLeadForTenantMock,
  DrizzleOrchestratorStore: DrizzleOrchestratorStoreMock,
}));
vi.mock("@savvy/agents", () => ({
  inngest: { send: sendMock },
}));
vi.mock("@savvy/orchestrator", () => ({
  publishDomainEvent: publishDomainEventMock,
  makeEvent: makeEventMock,
}));
vi.mock("@/lib/log", () => ({
  log: { info: vi.fn(), error: vi.fn() },
}));

import { POST } from "./route";

function voiceStatusRequest(fields: {
  To: string; From: string; CallSid?: string; DialCallStatus?: string; CallStatus?: string;
}) {
  const fd = new FormData();
  fd.set("To", fields.To);
  fd.set("From", fields.From);
  if (fields.CallSid) fd.set("CallSid", fields.CallSid);
  if (fields.DialCallStatus) fd.set("DialCallStatus", fields.DialCallStatus);
  if (fields.CallStatus) fd.set("CallStatus", fields.CallStatus);
  return new Request("http://localhost/api/twilio/voice-status", { method: "POST", body: fd });
}

describe("POST /api/twilio/voice-status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantByPhoneMock.mockResolvedValue({ id: "tenant-1", name: "Acme Roofing" });
    createLeadForTenantMock.mockResolvedValue("lead-1");
  });

  it("a missed call (DialCallStatus=no-answer) creates a missed_call lead, sends call/missed, and bridge-publishes call.missed", async () => {
    const req = voiceStatusRequest({
      To: "+15551230000", From: "+15550001111", CallSid: "CA1", DialCallStatus: "no-answer",
    });
    const res = await POST(req);
    const text = await res.text();

    expect(tenantByPhoneMock).toHaveBeenCalledWith("+15551230000");
    expect(createLeadForTenantMock).toHaveBeenCalledWith("tenant-1", {
      name: "Missed call +15550001111",
      phone: "+15550001111",
      address: "unknown",
      source: "missed_call",
    });
    expect(sendMock).toHaveBeenCalledWith({
      id: "call-missed-CA1",
      name: "call/missed",
      data: { tenantId: "tenant-1", leadId: "lead-1", fromNumber: "+15550001111", toNumber: "+15551230000" },
    });
    expect(DrizzleOrchestratorStoreMock).toHaveBeenCalled();
    expect(publishDomainEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "call.missed",
        source: "savvy",
        tenantId: "tenant-1",
        correlationId: "+15550001111",
        idempotencyKey: "call.missed:+15550001111:+15551230000:CA1",
        payload: { leadId: "lead-1", fromNumber: "+15550001111", toNumber: "+15551230000" },
      }),
    );
    expect(text).toBe("<Response/>");
  });

  it("reads CallStatus (call-resource callback) as well as DialCallStatus", async () => {
    const req = voiceStatusRequest({
      To: "+15551230000", From: "+15550004444", CallSid: "CA2", CallStatus: "busy",
    });
    await POST(req);

    expect(createLeadForTenantMock).toHaveBeenCalledWith("tenant-1", expect.objectContaining({ source: "missed_call" }));
    expect(sendMock).toHaveBeenCalled();
  });

  it("'failed' is treated as a missed call", async () => {
    const req = voiceStatusRequest({
      To: "+15551230000", From: "+15550005555", CallSid: "CA3", CallStatus: "failed",
    });
    await POST(req);

    expect(createLeadForTenantMock).toHaveBeenCalled();
  });

  it("a completed call does NOT create a lead, send the event, or publish — returns empty TwiML", async () => {
    const req = voiceStatusRequest({
      To: "+15551230000", From: "+15550002222", CallSid: "CA4", DialCallStatus: "completed", CallStatus: "completed",
    });
    const res = await POST(req);
    const text = await res.text();

    expect(createLeadForTenantMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    expect(publishDomainEventMock).not.toHaveBeenCalled();
    expect(text).toBe("<Response/>");
  });

  it("an unknown tenant (tenantByPhone -> null) returns empty TwiML with no side effects", async () => {
    tenantByPhoneMock.mockResolvedValue(null);
    const req = voiceStatusRequest({
      To: "+15559999999", From: "+15550003333", CallSid: "CA5", DialCallStatus: "no-answer",
    });
    const res = await POST(req);
    const text = await res.text();

    expect(createLeadForTenantMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    expect(publishDomainEventMock).not.toHaveBeenCalled();
    expect(text).toBe("<Response/>");
  });

  it("fail-soft: a bridge-publish error still returns the TwiML response (lead + event already succeeded)", async () => {
    publishDomainEventMock.mockRejectedValueOnce(new Error("bus down"));
    const req = voiceStatusRequest({
      To: "+15551230000", From: "+15550006666", CallSid: "CA6", DialCallStatus: "no-answer",
    });
    const res = await POST(req);
    const text = await res.text();

    expect(createLeadForTenantMock).toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalled();
    expect(text).toBe("<Response/>");
  });
});
