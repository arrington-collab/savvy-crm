import { describe, it, expect } from "vitest";
import { adminDb, withTenant, tenant, job, customer, property, jobStageEvent, communication, eq, and, suppress } from "@savvy/db";
import { evaluateTenantHomeownerNotifs } from "./homeowner-notify";

async function seedTenantWithEvent(toStage: string, optOut = false, enteredAt: Date = new Date()): Promise<{ tenantId: string; eventId: string; customerId: string; phone: string }> {
  const [t] = await adminDb.insert(tenant).values({ name: "HO Co", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`, settings: { homeowner: { enabled: true } } }).returning();
  const tenantId = t!.id;
  const phone = `+1555555${Math.floor(1000 + Math.random() * 9000)}`;
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "Homer", phone, email: "homer@e2e.test", smsOptOut: optOut, emailOptOut: optOut, smsConsentAt: new Date("2026-01-01") }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "1 Roof Ln" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: toStage as never }).returning();
  const [ev] = await adminDb.insert(jobStageEvent).values({ tenantId, jobId: j!.id, toStage: toStage as never, enteredAt }).returning();
  return { tenantId, eventId: ev!.id, customerId: c!.id, phone };
}

describe("evaluateTenantHomeownerNotifs", () => {
  it("sends + marks notified for a configured milestone, logs a communication", async () => {
    const { tenantId, eventId, customerId } = await seedTenantWithEvent("production");
    const r = await evaluateTenantHomeownerNotifs(tenantId, new Date());
    expect(r.sent).toBe(1);
    const [ev] = await withTenant(tenantId, (tx) => tx.select({ n: jobStageEvent.homeownerNotifiedAt }).from(jobStageEvent).where(eq(jobStageEvent.id, eventId)));
    expect(ev!.n).not.toBeNull();
    const comms = await withTenant(tenantId, (tx) => tx.select().from(communication).where(eq(communication.customerId, customerId)));
    expect(comms.length).toBeGreaterThanOrEqual(1);
  });
  it("no-ops for a non-configured stage (e.g. estimate not in default notifyStages)", async () => {
    const { tenantId } = await seedTenantWithEvent("estimate");
    expect((await evaluateTenantHomeownerNotifs(tenantId, new Date())).sent).toBe(0);
  });
  it("does not double-send on a second run", async () => {
    const { tenantId } = await seedTenantWithEvent("complete");
    await evaluateTenantHomeownerNotifs(tenantId, new Date());
    expect((await evaluateTenantHomeownerNotifs(tenantId, new Date())).sent).toBe(0);
  });
  it("suppresses SMS during quiet hours but still emails (TCPA-safe)", async () => {
    // 2026-07-15T08:00Z == 01:00 America/Phoenix, inside the default 21→08 quiet window.
    const quietNow = new Date("2026-07-15T08:00:00Z");
    const { tenantId, customerId } = await seedTenantWithEvent("production", false, quietNow);
    const r = await evaluateTenantHomeownerNotifs(tenantId, quietNow);
    expect(r.sent).toBe(1);
    const comms = await withTenant(tenantId, (tx) => tx.select().from(communication).where(eq(communication.customerId, customerId)));
    expect(comms.some((c) => c.channel === "email")).toBe(true);
    expect(comms.some((c) => c.channel === "sms")).toBe(false);
  });

  it("body_quality: every outbound body contains /b/ and no raw long token", async () => {
    // 16:00 UTC = 09:00 Arizona — well outside the 21→08 quiet window.
    const midMorning = new Date("2026-07-15T16:00:00Z");
    const { tenantId } = await seedTenantWithEvent("production", false, midMorning);
    await evaluateTenantHomeownerNotifs(tenantId, midMorning);
    const rows = await withTenant(tenantId, (tx) =>
      tx.select({ body: communication.body }).from(communication).where(eq(communication.tenantId, tenantId)),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.body).toContain("/b/");
      expect(r.body).not.toMatch(/https?:\/\/[^\s]{33,}/); // same rule as comms.body_quality
    }
  });

  it("dedupe: two runs over the same unstamped stage event produce exactly one SMS row", async () => {
    // 16:00 UTC = 09:00 Arizona — well outside the 21→08 quiet window so SMS is not suppressed.
    const midMorning = new Date("2026-07-15T16:00:00Z");
    const { tenantId, eventId } = await seedTenantWithEvent("production", false, midMorning);
    // First run: claims + marks notified
    await evaluateTenantHomeownerNotifs(tenantId, midMorning);
    // Simulate a ledger race: clear homeownerNotifiedAt so the cron sees the event again
    await adminDb.update(jobStageEvent).set({ homeownerNotifiedAt: null }).where(eq(jobStageEvent.id, eventId));
    // Second run: claim-then-send finds the dedupeKey already used → no second row
    await evaluateTenantHomeownerNotifs(tenantId, midMorning);
    const smsRows = await withTenant(tenantId, (tx) =>
      tx.select().from(communication).where(and(eq(communication.tenantId, tenantId), eq(communication.channel, "sms"))),
    );
    expect(smsRows).toHaveLength(1);
  });

  // Compliance follow-up: the SMS milestone send previously called
  // smsSender.sender.sendSms directly, bypassing the global contact_suppression
  // list. Proves guardedSms is wired: a globally suppressed, consented,
  // email-opted-out customer (SMS is the only viable channel) is not texted
  // and the event is not counted as delivered.
  it("globally suppressed customer (no other channel) → SMS not sent, not counted", async () => {
    // 16:00 UTC = 09:00 Arizona — outside quiet hours so SMS would otherwise send.
    const midMorning = new Date("2026-07-15T16:00:00Z");
    const [t] = await adminDb.insert(tenant).values({ name: "HO Co", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`, settings: { homeowner: { enabled: true } } }).returning();
    const tenantId = t!.id;
    const phone = "+15555559999";
    const [c] = await adminDb.insert(customer).values({ tenantId, name: "Homer", phone, email: "homer@e2e.test", smsOptOut: false, emailOptOut: true, smsConsentAt: new Date("2026-01-01") }).returning();
    const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "1 Roof Ln" }).returning();
    const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
    await adminDb.insert(jobStageEvent).values({ tenantId, jobId: j!.id, toStage: "production", enteredAt: midMorning });
    await suppress({ tenantId, phoneE164: phone, channel: "sms", reason: "stop", source: "test" });

    const r = await evaluateTenantHomeownerNotifs(tenantId, midMorning);
    // Not counted as delivered — guardedSms blocked the send on the global
    // suppression list (the claim row is still inserted for dedupe/idempotency,
    // but no message actually went out and it isn't counted as sent).
    expect(r.sent).toBe(0);
  });
});
