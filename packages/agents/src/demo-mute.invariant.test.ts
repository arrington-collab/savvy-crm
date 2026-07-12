import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { and, eq, adminDb, ensureTenantForOrg, __clearDemoTenantCache, tenant, communication } from "@savvy/db";
import { getTenantSms, getTenantVoice } from "./telephony";
import { getTenantEmail } from "./email";

let demoId: string;
let realId: string;
let fetchSpy: MockInstance<typeof globalThis.fetch>;

beforeEach(async () => {
  __clearDemoTenantCache();
  const d = await ensureTenantForOrg({ clerkOrgId: `org_inv_demo_${Date.now()}`, name: "Inv Demo" });
  demoId = d.id;
  await adminDb.update(tenant).set({ demo: true }).where(eq(tenant.id, demoId));
  const r = await ensureTenantForOrg({ clerkOrgId: `org_inv_real_${Date.now()}`, name: "Inv Real" });
  realId = r.id;
  // Spy on global fetch — Resend + Vapi + RingCentral all go through it.
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => {
  fetchSpy.mockRestore();
  __clearDemoTenantCache();
});

describe("comms.demo_mute invariant", () => {
  it("SMS/email/voice for a demo tenant hit NO provider and log mock rows", async () => {
    const { sender } = await getTenantSms(demoId);
    await sender.sendSms({ to: "+16025550100", from: "mock", body: "sms" });
    const email = await getTenantEmail(demoId, { gmailConnectionId: null });
    await email.sendEmail({ to: "a@b.com", from: "me@x.com", subject: "e", html: "<p>e</p>" });
    const voice = await getTenantVoice(demoId);
    await voice.placeOutboundCall({ toPhone: "+16025550100", assistantOverrides: {} as never, metadata: {} });

    // Zero provider HTTP calls to any known provider host.
    const providerCalls = fetchSpy.mock.calls.filter(([url]) => {
      const u = String(url);
      return u.includes("api.resend.com") || u.includes("api.vapi.ai") || u.includes("platform.ringcentral") || u.includes("twilio.com");
    });
    expect(providerCalls).toHaveLength(0);

    // Three mock rows logged.
    const rows = await adminDb
      .select()
      .from(communication)
      .where(and(eq(communication.tenantId, demoId), eq(communication.deliveryStatus, "mock")));
    expect(rows.map((r) => r.channel).sort()).toEqual(["call", "email", "sms"]);
  });

  it("negative control: a non-demo tenant resolves a real (platform) sender", async () => {
    const { sender, from } = await getTenantSms(realId);
    // Real path returns the platform sender + a real 'from' (not the literal 'mock').
    expect(from).not.toBe("mock");
    expect(typeof sender.sendSms).toBe("function");
  });
});
