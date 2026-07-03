import { describe, it, expect } from "vitest";
import { adminDb, withTenant, tenant, job, customer, property, jobStageEvent, communication, eq } from "@savvy/db";
import { evaluateTenantHomeownerNotifs } from "./homeowner-notify";

async function seedTenantWithEvent(toStage: string, optOut = false, enteredAt: Date = new Date()): Promise<{ tenantId: string; eventId: string; customerId: string }> {
  const [t] = await adminDb.insert(tenant).values({ name: "HO Co", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`, settings: { homeowner: { enabled: true } } }).returning();
  const tenantId = t!.id;
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "Homer", phone: "+15555551234", email: "homer@e2e.test", smsOptOut: optOut, emailOptOut: optOut }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "1 Roof Ln" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: toStage as never }).returning();
  const [ev] = await adminDb.insert(jobStageEvent).values({ tenantId, jobId: j!.id, toStage: toStage as never, enteredAt }).returning();
  return { tenantId, eventId: ev!.id, customerId: c!.id };
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
});
