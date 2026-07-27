import { describe, it, expect } from "vitest";
import { adminDb, withTenant, tenant, customer, property, job, communication, eq, suppress } from "@savvy/db";
import { sendCrewTouch } from "./homeowner-crew-notify";

// Compliance follow-up: homeownerCrewNotify's crew-day SMS touches previously
// called sender.sendSms directly inside the Inngest step.run callback,
// bypassing the global contact_suppression list. sendCrewTouch is the
// extracted, deps-injected send site (mirroring dunning.ts's sendDunningStep)
// so it's directly unit-testable without an Inngest test harness.

function fakeSmsDeps() {
  const sent: { to: string; body: string }[] = [];
  return {
    sent,
    getTenantSms: (async () => ({
      sender: { sendSms: async (m: { to: string; body: string }) => { sent.push(m); return { sid: "SM-mock" }; } },
      from: "+15555550000",
    })) as never,
    getTenantEmail: (async () => ({ sendEmail: async () => ({ id: "mock" }) })) as never,
  };
}

async function seedTenantCustomer(custOverrides: Partial<typeof customer.$inferInsert> = {}) {
  const [t] = await adminDb.insert(tenant).values({
    name: "Crew Co", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`,
  }).returning();
  const tenantId = t!.id;
  const [c] = await adminDb.insert(customer).values({
    tenantId, name: "Homer", phone: "+16025550111", smsConsentAt: new Date("2026-01-01"), ...custOverrides,
  }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "1 Crew Ln" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
  return { tenantId, jobId: j!.id, customerId: c!.id, phone: c!.phone as string };
}

describe("sendCrewTouch — crew-day SMS routed through guardedSms", () => {
  it("sends to a consented, reachable customer and logs the communication", async () => {
    const { tenantId, jobId, customerId, phone } = await seedTenantCustomer();
    const deps = fakeSmsDeps();

    const res = await sendCrewTouch({
      tenantId, jobId, customerId, phone, email: null, smsOptOut: false, emailOptOut: false,
      smsConsentAt: new Date("2026-01-01"), touchBody: "Crew arrives tomorrow!", link: "https://x.test/b/abc",
      gmailConnectionId: null,
    }, deps);

    expect(res.smsSent).toBe(true);
    expect(deps.sent).toHaveLength(1);
    expect(deps.sent[0]!.to).toBe(phone);

    const rows = await withTenant(tenantId, (tx) => tx.select().from(communication).where(eq(communication.jobId, jobId)));
    const smsRow = rows.find((r) => r.channel === "sms");
    expect(smsRow).toBeDefined();
    // Logged body must equal the real outbound body on a "sent" verdict.
    expect(smsRow!.body).toBe("Crew arrives tomorrow! Track your project: https://x.test/b/abc");
  });

  // Proves guardedSms is wired: a consented, non-opted-out customer who is
  // globally suppressed is NOT texted, AND that the logged communication row
  // does not fabricate a "delivered" record — it must reflect the blocked
  // verdict, not the real message body.
  it("globally suppressed customer → not texted, mock sender not called, logged body reflects the block (not the real body)", async () => {
    const { tenantId, jobId, customerId } = await seedTenantCustomer({ phone: "+16025550222" });
    await suppress({ tenantId, phoneE164: "+16025550222", channel: "sms", reason: "stop", source: "test" });
    const deps = fakeSmsDeps();

    const res = await sendCrewTouch({
      tenantId, jobId, customerId, phone: "+16025550222", email: null, smsOptOut: false, emailOptOut: false,
      smsConsentAt: new Date("2026-01-01"), touchBody: "Crew arrives tomorrow!", link: "https://x.test/b/abc",
      gmailConnectionId: null,
    }, deps);

    expect(res.smsSent).toBe(false);
    expect(deps.sent).toHaveLength(0);

    const rows = await withTenant(tenantId, (tx) => tx.select().from(communication).where(eq(communication.jobId, jobId)));
    const smsRow = rows.find((r) => r.channel === "sms");
    expect(smsRow).toBeDefined();
    expect(smsRow!.body).toContain("blocked: suppressed");
    expect(smsRow!.body).not.toBe("Crew arrives tomorrow! Track your project: https://x.test/b/abc");
  });

  // A thrown error (transient DB blip / provider 5xx) is fail-soft — swallowed,
  // never recorded as a false "sent".
  it("guardedSms/getTenantSms throw → fail-soft, not counted as sent", async () => {
    const { tenantId, jobId, customerId, phone } = await seedTenantCustomer({ phone: "+16025550333" });
    const throwingDeps = {
      getTenantSms: (async () => { throw new Error("provider 5xx"); }) as never,
      getTenantEmail: (async () => ({ sendEmail: async () => ({ id: "mock" }) })) as never,
    };

    const res = await sendCrewTouch({
      tenantId, jobId, customerId, phone, email: null, smsOptOut: false, emailOptOut: false,
      smsConsentAt: new Date("2026-01-01"), touchBody: "Crew arrives tomorrow!", link: "https://x.test/b/abc",
      gmailConnectionId: null,
    }, throwingDeps);

    expect(res.smsSent).toBe(false);
  });
});
