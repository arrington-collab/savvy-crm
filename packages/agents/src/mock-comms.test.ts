import { describe, it, expect, beforeEach } from "vitest";
import { adminDb, communication, ensureTenantForOrg, eq, and } from "@savvy/db";
import { makeMockSms, makeMockEmail, makeMockVoice } from "./mock-comms";

let tenantId: string;
beforeEach(async () => {
  const t = await ensureTenantForOrg({ clerkOrgId: `org_mock_${Date.now()}_${Math.floor(performance.now())}`, name: "Mock Co" });
  tenantId = t.id;
});

describe("mock senders", () => {
  it("mock SMS writes a mock communication row and returns a mock sid", async () => {
    const res = await makeMockSms(tenantId).sendSms({ to: "+16025550100", from: "+16025550111", body: "hi" });
    expect(res.sid).toMatch(/^mock:/);
    const rows = await adminDb.select().from(communication)
      .where(and(eq(communication.tenantId, tenantId), eq(communication.channel, "sms")));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deliveryStatus).toBe("mock");
    expect(rows[0]!.direction).toBe("outbound");
    expect(rows[0]!.body).toBe("hi");
  });

  it("mock email writes a mock communication row (channel=email)", async () => {
    const res = await makeMockEmail(tenantId).sendEmail({ to: "a@b.com", from: "me@x.com", subject: "S", html: "<p>x</p>" });
    expect(res.id).toMatch(/^mock:/);
    const rows = await adminDb.select().from(communication)
      .where(and(eq(communication.tenantId, tenantId), eq(communication.channel, "email")));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deliveryStatus).toBe("mock");
    expect(rows[0]!.body).toContain("S");
  });

  it("mock voice writes a call row and returns a mock callId", async () => {
    const res = await makeMockVoice(tenantId).placeOutboundCall({ toPhone: "+16025550100", assistantOverrides: {} as never, metadata: {} });
    expect(res?.callId).toMatch(/^mock:/);
    const rows = await adminDb.select().from(communication)
      .where(and(eq(communication.tenantId, tenantId), eq(communication.channel, "call")));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deliveryStatus).toBe("mock");
  });
});
