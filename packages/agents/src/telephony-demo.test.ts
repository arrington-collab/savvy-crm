import { describe, it, expect } from "vitest";
import { adminDb, ensureTenantForOrg, tenant, eq, __clearDemoTenantCache } from "@savvy/db";
import { getTenantSms, getTenantVoice } from "./telephony";

describe("demo tenants bypass provider resolution", () => {
  it("getTenantSms returns a mock sender for demo tenants without resolving creds", async () => {
    const t = await ensureTenantForOrg({ clerkOrgId: `org_tsms_${Date.now()}`, name: "TSMS" });
    await adminDb.update(tenant).set({ demo: true }).where(eq(tenant.id, t.id));
    __clearDemoTenantCache();
    // Pass a resolve that throws — proving it is never called for demo tenants.
    const deps = {
      resolve: async () => {
        throw new Error("must not resolve for demo");
      },
      platformSms: { sendSms: async () => ({ sid: "x" }) },
      platformFrom: () => "+1",
    } as never;
    const { sender } = await getTenantSms(t.id, deps);
    const res = await sender.sendSms({ to: "+16025550100", from: "+1", body: "hi" });
    expect(res.sid).toMatch(/^mock:/);
  });

  it("getTenantVoice returns a mock gateway for demo tenants without resolving creds", async () => {
    const t = await ensureTenantForOrg({ clerkOrgId: `org_tvoice_${Date.now()}`, name: "TVOICE" });
    await adminDb.update(tenant).set({ demo: true }).where(eq(tenant.id, t.id));
    __clearDemoTenantCache();
    const deps = {
      resolve: async () => {
        throw new Error("must not resolve for demo");
      },
      platformVoice: { placeOutboundCall: async () => ({ callId: "x" }) },
    } as never;
    const gateway = await getTenantVoice(t.id, deps);
    const res = await gateway.placeOutboundCall({
      toPhone: "+16025550100",
      assistantOverrides: {} as never,
      metadata: {},
    });
    expect(res?.callId).toMatch(/^mock:/);
  });
});
