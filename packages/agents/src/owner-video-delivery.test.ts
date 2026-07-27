import { describe, it, expect, beforeAll } from "vitest";
import { customer, property, lead, measurement, tierProduct, estimate, withTenant, eq } from "@savvy/db";
import { ensureTenantForOrg, ensurePriceBook, ensureTierProducts, suppress } from "@savvy/db";
import { createEstimateFromMeasurement, setEstimateStatus, listEstimateEvents } from "@savvy/db";
import { deliverOwnerVideos } from "./functions/owner-video-delivery";

let tenantId: string;
let estimateId: string;
let sent: { to: string; body: string }[] = [];
const fakeSms = {
  getTenantSms: async () => ({
    sender: { sendSms: async (o: { to: string; body: string }) => { sent.push(o); return { sid: "mock" }; } },
    from: "+15550000000",
  }),
};

beforeAll(async () => {
  const t = await ensureTenantForOrg({ clerkOrgId: `org_ovd_${Date.now()}`, name: "OVD Test" });
  tenantId = t.id;
  await ensurePriceBook(tenantId);
  await ensureTierProducts(tenantId);
  await withTenant(tenantId, (tx) => tx.update(tierProduct).set({ unitPriceCents: 20000, unitCostCents: 12000 }));
  const ids = await withTenant(tenantId, async (tx) => {
    // Stamp smsConsentAt so guardedSms admits the happy-path send.
    const [c] = await tx.insert(customer).values({ tenantId, name: "Day After", phone: "+16025550666", smsConsentAt: new Date("2026-01-01") }).returning();
    const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: "1 OVD St", city: "Gilbert" }).returning();
    const [l] = await tx.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, source: "referral", status: "qualified" }).returning();
    const [m] = await tx.insert(measurement).values({ tenantId, propertyId: p!.id, provider: "roofr", areas: { squares: 20, predominantPitch: "6/12", eaveLf: 100, rakeLf: 50 } }).returning();
    return { leadId: l!.id, measurementId: m!.id };
  });
  const est = await createEstimateFromMeasurement({ tenantId, leadId: ids.leadId, measurementId: ids.measurementId });
  estimateId = est!.id;
  await setEstimateStatus({ tenantId, estimateId, status: "sent" });
  // put it in the day-after window
  await withTenant(tenantId, (tx) =>
    tx.update(estimate).set({ sentAt: new Date(Date.now() - 26 * 3_600_000) }).where(eq(estimate.id, estimateId)),
  );
  // configure the generic tenant video
  const { adminDb, tenant, sql } = await import("@savvy/db");
  await adminDb.update(tenant).set({
    // quietHours start==end = empty window: this test runs at ANY wall-clock hour
    // (it was failing 21:00–08:00 UTC — quiet hours correctly suppressed the send).
    // Quiet-hours behavior itself is covered by the quiet-hours unit tests.
    settings: sql`coalesce(${tenant.settings}, '{}'::jsonb) || '{"ownerVideo": {"genericDocumentId": "generic-vid-doc"}, "homeowner": {"quietHours": {"startHour": 0, "endHour": 0}}}'::jsonb`,
  }).where(eq(tenant.id, tenantId));
});

describe("deliverOwnerVideos", () => {
  it("sends the generic fallback with the wrapper, records video_sent, and never double-sends", async () => {
    sent = [];
    const first = await deliverOwnerVideos(tenantId, { ...fakeSms, now: () => new Date() });
    expect(first.sent).toBe(1);
    expect(sent[0]!.to).toBe("+16025550666");
    expect(sent[0]!.body).toContain("owner wanted a word");
    expect(sent[0]!.body).toContain("?v=1");

    const events = await listEstimateEvents(tenantId, estimateId);
    const evt = events.find((e) => e.kind === "video_sent");
    expect(evt).toBeDefined();
    expect((evt!.meta as { personalized: boolean }).personalized).toBe(false);

    // once per estimate, ever
    const again = await deliverOwnerVideos(tenantId, { ...fakeSms, now: () => new Date() });
    expect(again.sent).toBe(0);
  });

  // Compliance follow-up: deliverOwnerVideos previously called sender.sendSms
  // directly, bypassing the global contact_suppression list. Proves guardedSms
  // is wired: a consented, non-opted-out homeowner who is globally suppressed
  // is NOT texted, and the video_sent gate still closes so the queue doesn't
  // re-offer the estimate forever.
  it("globally suppressed homeowner -> sender NOT called, no delivered status, video_sent still recorded once", async () => {
    const suppressedPhone = "+16025550777";
    const ids = await withTenant(tenantId, async (tx) => {
      const [c] = await tx.insert(customer).values({ tenantId, name: "Suppressed Owner", phone: suppressedPhone, smsConsentAt: new Date("2026-01-01") }).returning();
      const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: "2 OVD St", city: "Gilbert" }).returning();
      const [l] = await tx.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, source: "referral", status: "qualified" }).returning();
      const [m] = await tx.insert(measurement).values({ tenantId, propertyId: p!.id, provider: "roofr", areas: { squares: 20, predominantPitch: "6/12", eaveLf: 100, rakeLf: 50 } }).returning();
      return { leadId: l!.id, measurementId: m!.id };
    });
    const est2 = await createEstimateFromMeasurement({ tenantId, leadId: ids.leadId, measurementId: ids.measurementId });
    const est2Id = est2!.id;
    await setEstimateStatus({ tenantId, estimateId: est2Id, status: "sent" });
    await withTenant(tenantId, (tx) =>
      tx.update(estimate).set({ sentAt: new Date(Date.now() - 26 * 3_600_000) }).where(eq(estimate.id, est2Id)),
    );
    await suppress({ tenantId, phoneE164: suppressedPhone, channel: "sms", reason: "stop", source: "test" });

    sent = [];
    await deliverOwnerVideos(tenantId, { ...fakeSms, now: () => new Date() });
    expect(sent).toHaveLength(0);

    const events = await listEstimateEvents(tenantId, est2Id);
    const evt = events.find((e) => e.kind === "video_sent");
    expect(evt).toBeDefined();
    expect((evt!.meta as { suppressed?: string }).suppressed).toContain("guard");

    // The gate closes even on a blocked verdict — a later run never retries.
    const again = await deliverOwnerVideos(tenantId, { ...fakeSms, now: () => new Date() });
    expect(again.sent).toBe(0);
    expect(sent).toHaveLength(0);
  });

  // A THROWN error (transient DB blip / provider 5xx) must NOT be treated as a
  // blocked verdict: no video_sent event, no delivered status, no false sent
  // count — the once-ever gate stays open so the next pass retries.
  it("guardedSms throw is NOT recorded as video_sent — a later pass retries", async () => {
    const throwPhone = "+16025550888";
    const ids = await withTenant(tenantId, async (tx) => {
      const [c] = await tx.insert(customer).values({ tenantId, name: "Throw Owner", phone: throwPhone, smsConsentAt: new Date("2026-01-01") }).returning();
      const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: "3 OVD St", city: "Gilbert" }).returning();
      const [l] = await tx.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, source: "referral", status: "qualified" }).returning();
      const [m] = await tx.insert(measurement).values({ tenantId, propertyId: p!.id, provider: "roofr", areas: { squares: 20, predominantPitch: "6/12", eaveLf: 100, rakeLf: 50 } }).returning();
      return { leadId: l!.id, measurementId: m!.id };
    });
    const est3 = await createEstimateFromMeasurement({ tenantId, leadId: ids.leadId, measurementId: ids.measurementId });
    const est3Id = est3!.id;
    await setEstimateStatus({ tenantId, estimateId: est3Id, status: "sent" });
    await withTenant(tenantId, (tx) =>
      tx.update(estimate).set({ sentAt: new Date(Date.now() - 26 * 3_600_000) }).where(eq(estimate.id, est3Id)),
    );

    const throwingDeps = { getTenantSms: async () => { throw new Error("provider 5xx"); } };
    const first = await deliverOwnerVideos(tenantId, { ...throwingDeps, now: () => new Date() });
    expect(first.sent).toBe(0);

    const events = await listEstimateEvents(tenantId, est3Id);
    expect(events.some((e) => e.kind === "video_sent")).toBe(false);

    sent = [];
    const retry = await deliverOwnerVideos(tenantId, { ...fakeSms, now: () => new Date() });
    expect(retry.sent).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(throwPhone);
  });
});
