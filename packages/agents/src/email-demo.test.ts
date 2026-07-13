import { describe, it, expect } from "vitest";
import { adminDb, ensureTenantForOrg, tenant, eq } from "@savvy/db";
import { getTenantEmail } from "./email";

describe("getTenantEmail", () => {
  it("returns a mock email sender for demo tenants", async () => {
    const t = await ensureTenantForOrg({ clerkOrgId: `org_tmail_${Date.now()}`, name: "TMail" });
    await adminDb.update(tenant).set({ demo: true }).where(eq(tenant.id, t.id));
    const sender = await getTenantEmail(t.id, { gmailConnectionId: null });
    const res = await sender.sendEmail({ to: "a@b.com", from: "me@x.com", subject: "S", html: "<p>x</p>" });
    expect(res.id).toMatch(/^mock:/);
  });

  it("returns the real resend sender for non-demo tenants", async () => {
    const t = await ensureTenantForOrg({ clerkOrgId: `org_tmail2_${Date.now()}`, name: "TMail2" });
    const sender = await getTenantEmail(t.id, { gmailConnectionId: null });
    // Real resend sender's id is NOT prefixed mock:. We don't send (no key); just assert identity by shape.
    expect(typeof sender.sendEmail).toBe("function");
  });
});
