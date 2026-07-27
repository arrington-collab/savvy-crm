import { describe, it, expect, beforeAll } from "vitest";
import { adminDb, eq, tenant, customer, property, lead, user, measurement, tierProduct, withTenant, communication, suppress } from "@savvy/db";
import { ensureTenantForOrg, ensurePriceBook, ensureTierProducts } from "@savvy/db";
import { createEstimateFromMeasurement, setEstimateStatus } from "@savvy/db";
import { recordEstimateEvent, listEstimateEvents } from "@savvy/db";
import { raceNotify, raceResolve } from "./estimate-race";

let tenantId: string;
let custId: string;
let estimateId: string;
let sent: { to: string; body: string }[] = [];

const fakeSms = {
  getTenantSms: async () => ({
    sender: { sendSms: async (o: { to: string; body: string }) => { sent.push(o); return { sid: "mock" }; } },
    from: "+15550000000",
  }),
};

beforeAll(async () => {
  const t = await ensureTenantForOrg({ clerkOrgId: `org_race_${Date.now()}`, name: "Race Test" });
  tenantId = t.id;
  await ensurePriceBook(tenantId);
  await ensureTierProducts(tenantId);
  await withTenant(tenantId, (tx) => tx.update(tierProduct).set({ unitPriceCents: 20000, unitCostCents: 12000 }));

  const ids = await withTenant(tenantId, async (tx) => {
    const [rep] = await tx.insert(user).values({ tenantId, name: "Race Rep", email: `rep-${Date.now()}@e2e.test`, role: "rep", phone: "+16025550777" }).returning();
    const [c] = await tx.insert(customer).values({ tenantId, name: "Hot Homeowner", phone: "+16025550888", smsConsentAt: new Date("2026-01-01") }).returning();
    custId = c!.id;
    const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: "9 Race St", city: "Phoenix", state: "AZ" }).returning();
    const [l] = await tx.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, source: "referral", status: "qualified", assignedUserId: rep!.id }).returning();
    const [m] = await tx.insert(measurement).values({ tenantId, propertyId: p!.id, provider: "roofr", areas: { squares: 20, predominantPitch: "6/12", eaveLf: 100, rakeLf: 50 } }).returning();
    return { leadId: l!.id, measurementId: m!.id };
  });
  const est = await createEstimateFromMeasurement({ tenantId, leadId: ids.leadId, measurementId: ids.measurementId });
  estimateId = est!.id;
  await setEstimateStatus({ tenantId, estimateId, status: "sent" });
});

describe("raceNotify", () => {
  it("texts the ASSIGNED REP with the customer name + one-tap links and records the event", async () => {
    sent = [];
    const res = await raceNotify(
      { tenantId, estimateId, sessionId: "sess-1", baseUrl: "https://x" },
      { ...fakeSms, now: () => new Date("2026-07-13T19:00:00Z") }, // midday Phoenix — outside quiet hours
    );
    expect(res.notified).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("+16025550777");
    expect(sent[0]!.body).toContain("Hot Homeowner");
    expect(sent[0]!.body).toContain("tel:+16025550888");
    const events = await listEstimateEvents(tenantId, estimateId);
    expect(events.some((e) => e.kind === "race_rep_notified" && e.sessionId === "sess-1")).toBe(true);
  });

  it("skips entirely inside quiet hours (records race_skipped, no SMS)", async () => {
    sent = [];
    const res = await raceNotify(
      { tenantId, estimateId, sessionId: "sess-quiet", baseUrl: "https://x" },
      { ...fakeSms, now: () => new Date("2026-07-13T09:00:00Z") }, // 2am Phoenix
    );
    expect(res.notified).toBe(false);
    expect(sent).toHaveLength(0);
    const events = await listEstimateEvents(tenantId, estimateId);
    expect(events.some((e) => e.kind === "race_skipped" && e.sessionId === "sess-quiet")).toBe(true);
  });
});

describe("raceResolve", () => {
  it("rep acked within the window → NOVA stays silent", async () => {
    sent = [];
    await recordEstimateEvent({ tenantId, estimateId, kind: "race_rep_ack", sessionId: "sess-1" });
    const res = await raceResolve({ tenantId, estimateId, sessionId: "sess-1" }, fakeSms);
    expect(res.novaTexted).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("no rep response → NOVA texts the CUSTOMER once and records it", async () => {
    sent = [];
    const res = await raceResolve({ tenantId, estimateId, sessionId: "sess-2" }, fakeSms);
    expect(res.novaTexted).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("+16025550888");
    expect(sent[0]!.body.toLowerCase()).toContain("estimate");
    const events = await listEstimateEvents(tenantId, estimateId);
    expect(events.some((e) => e.kind === "race_nova_text" && e.sessionId === "sess-2")).toBe(true);
  });

  // Compliance follow-up: raceResolve previously called sender.sendSms directly,
  // bypassing the global contact_suppression list (a homeowner who STOPped a
  // DIFFERENT agent could still get raced). Proves guardedSms is wired: a
  // globally-suppressed, consented, non-opted-out customer is NOT texted.
  it("globally suppressed customer → NOVA does NOT text and logs a blocked comm", async () => {
    sent = [];
    await suppress({ tenantId, phoneE164: "+16025550888", channel: "sms", reason: "stop", source: "test" });
    const res = await raceResolve({ tenantId, estimateId, sessionId: "sess-3" }, fakeSms);
    expect(res.novaTexted).toBe(false);
    expect(sent).toHaveLength(0);
    const comms = await withTenant(tenantId, (tx) => tx.select().from(communication).where(eq(communication.customerId, custId)));
    expect(comms.some((r) => r.body?.includes("blocked: suppressed"))).toBe(true);
  });
});
