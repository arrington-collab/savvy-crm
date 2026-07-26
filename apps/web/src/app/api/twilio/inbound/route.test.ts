import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock every collaborator so this exercises ONLY the route's STOP/HELP branch.
// vi.mock factories are hoisted above imports, so the mock fns must be too.
const { tenantByPhoneMock, createLeadForTenantMock, handleInboundSmsMock, suppressMock } = vi.hoisted(() => ({
  tenantByPhoneMock: vi.fn(),
  createLeadForTenantMock: vi.fn(),
  handleInboundSmsMock: vi.fn(),
  suppressMock: vi.fn(),
}));

vi.mock("@/lib/intake", () => ({
  tenantByPhone: tenantByPhoneMock,
  createLeadForTenant: createLeadForTenantMock,
}));
vi.mock("@/lib/inbound-sms", () => ({
  handleInboundSms: handleInboundSmsMock,
}));
vi.mock("@savvy/db", () => ({
  suppress: suppressMock,
}));
vi.mock("@/lib/log", () => ({
  log: { info: vi.fn(), error: vi.fn() },
}));

import { POST } from "./route";

function inboundSmsRequest(fields: { To: string; From: string; Body: string; MessageSid?: string }) {
  const fd = new FormData();
  fd.set("To", fields.To);
  fd.set("From", fields.From);
  fd.set("Body", fields.Body);
  if (fields.MessageSid) fd.set("MessageSid", fields.MessageSid);
  return new Request("http://localhost/api/twilio/inbound", { method: "POST", body: fd });
}

describe("POST /api/twilio/inbound — STOP/HELP", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantByPhoneMock.mockResolvedValue({ id: "tenant-1", name: "Acme Roofing" });
    handleInboundSmsMock.mockResolvedValue({ matched: true, stopped: "opted_out" });
  });

  it("STOP calls global suppress with the right args and replies with a confirmation", async () => {
    const req = inboundSmsRequest({ To: "+15551230000", From: "+15550001111", Body: "STOP", MessageSid: "SM1" });
    const res = await POST(req);
    const text = await res.text();

    expect(suppressMock).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      phoneE164: "+15550001111",
      channel: "sms",
      reason: "stop",
      source: "twilio-inbound",
    });
    expect(text).toContain("<Message>");
    expect(text.toLowerCase()).toContain("unsubscribed");
    // Existing per-customer opt-out behavior stays wired (additive, not removed).
    expect(handleInboundSmsMock).toHaveBeenCalledWith("tenant-1", {
      from: "+15550001111",
      body: "STOP",
      twilioSid: "SM1",
    });
  });

  it("HELP replies with an info message and does NOT suppress", async () => {
    const req = inboundSmsRequest({ To: "+15551230000", From: "+15550002222", Body: "help", MessageSid: "SM2" });
    const res = await POST(req);
    const text = await res.text();

    expect(suppressMock).not.toHaveBeenCalled();
    expect(text).toContain("<Message>");
    expect(text.toLowerCase()).toContain("stop to opt out");
    expect(text).toContain("Acme Roofing");
  });

  it("INFO (alternate keyword) also replies with info and does NOT suppress", async () => {
    const req = inboundSmsRequest({ To: "+15551230000", From: "+15550002223", Body: "Info", MessageSid: "SM4" });
    const res = await POST(req);
    const text = await res.text();

    expect(suppressMock).not.toHaveBeenCalled();
    expect(text.toLowerCase()).toContain("stop to opt out");
  });

  it("a normal message neither suppresses nor sends a STOP/HELP reply", async () => {
    const req = inboundSmsRequest({ To: "+15551230000", From: "+15550003333", Body: "Yes see you then", MessageSid: "SM3" });
    const res = await POST(req);
    const text = await res.text();

    expect(suppressMock).not.toHaveBeenCalled();
    expect(text.toLowerCase()).not.toContain("unsubscribed");
    expect(text.toLowerCase()).not.toContain("stop to opt out");
    expect(handleInboundSmsMock).toHaveBeenCalled();
  });
});
