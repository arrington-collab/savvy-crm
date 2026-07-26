import { describe, it, expect, beforeAll } from "vitest";
import {
  adminDb, eq, sql, tenant, customer, property, lead, measurement, tierProduct, estimate, withTenant,
  ensurePriceBook, ensureTierProducts, createEstimateFromMeasurement, setEstimateStatus,
  listEstimateEvents, suppress,
} from "@savvy/db";
import { sweepTenantEstimateExpiry } from "./estimate-expiry";

let tenantId: string;

beforeAll(async () => {
  const [t] = await adminDb.insert(tenant).values({
    name: "ExpirySweep", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`,
    // Wide-open quiet hours — the sweep must never skip for time-of-day reasons in this suite.
    settings: { homeowner: { quietHours: { startHour: 0, endHour: 0 } } } as never,
  }).returning();
  tenantId = t!.id;
  await ensurePriceBook(tenantId);
  await ensureTierProducts(tenantId);
  await withTenant(tenantId, (tx) => tx.update(tierProduct).set({ unitPriceCents: 20000, unitCostCents: 12000 }));
});

/** Seed a customer + property + lead + measurement + a "sent" estimate whose
 *  sentAt is aged well past the default 30-day validity window. */
async function seedExpiredEstimate(custOverrides: Partial<typeof customer.$inferInsert> = {}) {
  const [c] = await adminDb.insert(customer).values({
    tenantId, name: "Expiring Homeowner", phone: "+16025550999", smsConsentAt: new Date("2026-01-01"), ...custOverrides,
  }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "1 Expiry Way", city: "Phoenix", state: "AZ" }).returning();
  const [l] = await adminDb.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, source: "referral", status: "qualified" }).returning();
  const [m] = await adminDb.insert(measurement).values({ tenantId, propertyId: p!.id, provider: "roofr", areas: { squares: 20, predominantPitch: "6/12", eaveLf: 100, rakeLf: 50 } }).returning();
  const est = await createEstimateFromMeasurement({ tenantId, leadId: l!.id, measurementId: m!.id });
  const estimateId = est!.id;
  await setEstimateStatus({ tenantId, estimateId, status: "sent" });
  await adminDb.update(estimate).set({ sentAt: sql`now() - interval '40 days'` }).where(eq(estimate.id, estimateId));
  return { estimateId, custId: c!.id, phone: c!.phone as string };
}

describe("sweepTenantEstimateExpiry", () => {
  it("sends the expiry notice to a consented, reachable homeowner exactly once", async () => {
    const { estimateId, phone } = await seedExpiredEstimate();
    const sent: { to: string; body: string }[] = [];
    const deps = {
      getTenantSms: (async () => ({
        sender: { sendSms: async (m: { to: string; body: string }) => { sent.push(m); return { sid: "mock" }; } },
        from: "+15555550000",
      })) as never,
    };

    const first = await sweepTenantEstimateExpiry(tenantId, deps);
    expect(first.noticed).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(phone);
    expect(sent[0]!.body.toLowerCase()).toContain("expired");

    const again = await sweepTenantEstimateExpiry(tenantId, deps);
    expect(again.noticed).toBe(0); // once, ever
    expect(sent).toHaveLength(1);

    const events = await listEstimateEvents(tenantId, estimateId);
    expect(events.some((e) => e.kind === "expiry_notice")).toBe(true);
  });

  // Compliance follow-up: sweepTenantEstimateExpiry previously called
  // sender.sendSms directly, bypassing the global contact_suppression list.
  // Proves guardedSms is wired: a consented, non-opted-out homeowner who is
  // globally suppressed is NOT texted.
  it("globally suppressed homeowner → not texted, expiry_notice still recorded once", async () => {
    const { estimateId } = await seedExpiredEstimate({ phone: "+16025551000" });
    await suppress({ tenantId, phoneE164: "+16025551000", channel: "sms", reason: "stop", source: "test" });
    const sent: { to: string; body: string }[] = [];
    const deps = {
      getTenantSms: (async () => ({
        sender: { sendSms: async (m: { to: string; body: string }) => { sent.push(m); return { sid: "mock" }; } },
        from: "+15555550000",
      })) as never,
    };

    const res = await sweepTenantEstimateExpiry(tenantId, deps);
    expect(res.noticed).toBe(0);
    expect(sent).toHaveLength(0);

    const events = await listEstimateEvents(tenantId, estimateId);
    const notice = events.find((e) => e.kind === "expiry_notice");
    expect(notice).toBeTruthy();
    expect(notice!.meta?.suppressed).toContain("guard");

    // Re-running never retries this estimate — the "once, ever" gate holds
    // even for a blocked send.
    const again = await sweepTenantEstimateExpiry(tenantId, deps);
    expect(again.noticed).toBe(0);
    expect(sent).toHaveLength(0);
  });
});
