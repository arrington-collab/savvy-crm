import { describe, it, expect, beforeAll } from "vitest";
import { customer, property, lead, measurement, tierProduct, estimate, withTenant, eq } from "@savvy/db";
import { ensureTenantForOrg, ensurePriceBook, ensureTierProducts } from "@savvy/db";
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
    const [c] = await tx.insert(customer).values({ tenantId, name: "Day After", phone: "+16025550666" }).returning();
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
});
