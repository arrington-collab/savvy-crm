import { describe, it, expect } from "vitest";
import { adminDb, withTenant, tenant, customer, property, job, communication, productionUpdate, eq, and, suppress } from "@savvy/db";
import { sendDeliveryTouch } from "./homeowner-delivery-notify";

// Compliance follow-up: homeownerDeliveryNotify's delivery-touch SMS legs
// previously called sender.sendSms directly inside the Inngest step.run
// callback, bypassing the global contact_suppression list. sendDeliveryTouch
// is the extracted, deps-injected send site (mirroring dunning.ts's
// sendDunningStep) so it's directly unit-testable without an Inngest harness.

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
    name: "Delivery Co", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`,
  }).returning();
  const tenantId = t!.id;
  const [c] = await adminDb.insert(customer).values({
    tenantId, name: "Homer", phone: "+16025550444", smsConsentAt: new Date("2026-01-01"), ...custOverrides,
  }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "1 Delivery Ln" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
  return { tenantId, jobId: j!.id, customerId: c!.id, phone: c!.phone as string };
}

describe("sendDeliveryTouch — delivery SMS routed through guardedSms", () => {
  it("sends to a consented, reachable customer and logs a completed production update", async () => {
    const { tenantId, jobId, customerId, phone } = await seedTenantCustomer();
    const deps = fakeSmsDeps();

    const res = await sendDeliveryTouch({
      tenantId, jobId, customerId, kind: "delivery_3day",
      phone, email: null, smsOptOut: false, emailOptOut: false, smsConsentAt: new Date("2026-01-01"),
      body: "Your materials arrive in 3 days.", link: "https://x.test/b/abc", gmailConnectionId: null,
    }, deps);

    expect(res.smsSent).toBe(true);
    expect(deps.sent).toHaveLength(1);
    expect(deps.sent[0]!.to).toBe(phone);

    const rows = await withTenant(tenantId, (tx) => tx.select().from(communication).where(and(eq(communication.jobId, jobId), eq(communication.channel, "sms"))));
    expect(rows).toHaveLength(1);

    const updates = await withTenant(tenantId, (tx) => tx.select().from(productionUpdate).where(eq(productionUpdate.jobId, jobId)));
    expect(updates).toHaveLength(1);
    expect(updates[0]!.sentAt).not.toBeNull();
    expect(updates[0]!.suppressedReason).toBeNull();
  });

  // Proves guardedSms is wired: a consented, non-opted-out customer who is
  // globally suppressed is NOT texted, and the production_update ledger
  // records a suppression — never a completed delivery notice.
  it("globally suppressed customer → not texted, logged as suppressed (not a completed notice)", async () => {
    const { tenantId, jobId, customerId } = await seedTenantCustomer({ phone: "+16025550555" });
    await suppress({ tenantId, phoneE164: "+16025550555", channel: "sms", reason: "stop", source: "test" });
    const deps = fakeSmsDeps();

    const res = await sendDeliveryTouch({
      tenantId, jobId, customerId, kind: "delivery_3day",
      phone: "+16025550555", email: null, smsOptOut: false, emailOptOut: false, smsConsentAt: new Date("2026-01-01"),
      body: "Your materials arrive in 3 days.", link: "https://x.test/b/abc", gmailConnectionId: null,
    }, deps);

    expect(res.smsSent).toBe(false);
    expect(deps.sent).toHaveLength(0);

    const updates = await withTenant(tenantId, (tx) => tx.select().from(productionUpdate).where(eq(productionUpdate.jobId, jobId)));
    expect(updates).toHaveLength(1);
    expect(updates[0]!.sentAt).toBeNull();
    expect(updates[0]!.suppressedReason).toContain("guard_");
  });

  // A thrown error (transient DB blip / provider 5xx) is fail-soft — swallowed,
  // never recorded as a false "sent" or a completed delivery notice.
  it("guardedSms/getTenantSms throw → fail-soft, logged as suppressed, not sent", async () => {
    const { tenantId, jobId, customerId, phone } = await seedTenantCustomer({ phone: "+16025550666" });
    const throwingDeps = {
      getTenantSms: (async () => { throw new Error("provider 5xx"); }) as never,
      getTenantEmail: (async () => ({ sendEmail: async () => ({ id: "mock" }) })) as never,
    };

    const res = await sendDeliveryTouch({
      tenantId, jobId, customerId, kind: "delivery_eve",
      phone, email: null, smsOptOut: false, emailOptOut: false, smsConsentAt: new Date("2026-01-01"),
      body: "Your materials arrive tomorrow.", link: "https://x.test/b/abc", gmailConnectionId: null,
    }, throwingDeps);

    expect(res.smsSent).toBe(false);
    const updates = await withTenant(tenantId, (tx) => tx.select().from(productionUpdate).where(eq(productionUpdate.jobId, jobId)));
    expect(updates).toHaveLength(1);
    expect(updates[0]!.sentAt).toBeNull();
    expect(updates[0]!.suppressedReason).toBe("guard_error");
  });
});
