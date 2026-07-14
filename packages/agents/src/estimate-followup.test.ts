import { describe, it, expect, beforeAll } from "vitest";
import { customer, property, lead, measurement, tierProduct, communication, withTenant, eq, and, desc } from "@savvy/db";
import { ensureTenantForOrg, ensurePriceBook, ensureTierProducts, ensureEstimateFollowupDrip, ESTIMATE_FOLLOWUP_DRIP_KEY } from "@savvy/db";
import { createEstimateFromMeasurement, setEstimateStatus, listEstimateEvents, drip } from "@savvy/db";
import { sendDripStep } from "./functions/drip";
import { createEstimateSubmission, __setDripEmitter } from "./functions/estimate-sign";
import { makeFakeDocuseal } from "@savvy/integrations";

let tenantId: string;
let estimateId: string;
let leadId: string;
let customerId: string;
let sent: { to: string; body: string }[] = [];

const deps = {
  sms: { sendSms: async (o: { to: string; body: string }) => { sent.push(o); return { sid: "mock" }; } },
  email: { sendEmail: async () => ({ id: "mock" }) },
  from: "+15550000000",
  isThrottled: async () => false,
};

beforeAll(async () => {
  const t = await ensureTenantForOrg({ clerkOrgId: `org_fu_${Date.now()}`, name: "Followup Test" });
  tenantId = t.id;
  await ensurePriceBook(tenantId);
  await ensureTierProducts(tenantId);
  await withTenant(tenantId, (tx) => tx.update(tierProduct).set({ unitPriceCents: 20000, unitCostCents: 12000 }));
  const ids = await withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name: "Follow Up", phone: "+16025550333" }).returning();
    const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: "6 FU Ln", city: "Chandler" }).returning();
    const [l] = await tx.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, source: "referral", status: "qualified" }).returning();
    const [m] = await tx.insert(measurement).values({ tenantId, propertyId: p!.id, provider: "roofr", areas: { squares: 20, predominantPitch: "6/12", eaveLf: 100, rakeLf: 50 } }).returning();
    return { leadId: l!.id, measurementId: m!.id, customerId: c!.id };
  });
  leadId = ids.leadId;
  customerId = ids.customerId;
  const est = await createEstimateFromMeasurement({ tenantId, leadId, measurementId: ids.measurementId });
  estimateId = est!.id;
  await setEstimateStatus({ tenantId, estimateId, status: "sent" });
});

describe("ensureEstimateFollowupDrip", () => {
  it("seeds the sequence with its gated slots, idempotently", async () => {
    const first = await ensureEstimateFollowupDrip(tenantId);
    expect(first.seeded).toBe(true);
    const again = await ensureEstimateFollowupDrip(tenantId);
    expect(again.seeded).toBe(false);

    const [row] = await withTenant(tenantId, (tx) =>
      tx.select().from(drip).where(eq(drip.key, ESTIMATE_FOLLOWUP_DRIP_KEY)),
    );
    expect(row!.steps).toHaveLength(4);
    expect(row!.steps[1]!.gate).toBe("financing_live");
    expect(row!.steps[2]!.gate).toBe("feature:color_render");
  });
});

describe("gated + estimate-aware sends", () => {
  it("renders the live page link into a follow-up touch and stamps followup_sent", async () => {
    sent = [];
    const enrollmentId = crypto.randomUUID(); // sendDripStep only updates by id — a miss is harmless here
    const res = await sendDripStep(
      {
        tenantId, enrollmentId, customerId, leadId,
        step: { stepNum: 1, delayHours: 96, channel: "sms", templateKey: "estimate-followup-day4" },
        templateBody: "Hi {{firstName}} — warranty details: {{estimateLink}} (locked through {{validUntil}})",
      },
      deps,
    );
    expect(res.sent).toBe(true);
    expect(sent[0]!.body).toContain("/estimate/");
    expect(sent[0]!.body).toMatch(/locked through [A-Z][a-z]+ \d+/);
    const events = await listEstimateEvents(tenantId, estimateId);
    expect(events.some((e) => e.kind === "followup_sent")).toBe(true);
  });

  it("a closed gate suppresses the send (logged), the sequence moves on", async () => {
    sent = [];
    const res = await sendDripStep(
      {
        tenantId, enrollmentId: crypto.randomUUID(), customerId, leadId,
        step: { stepNum: 2, delayHours: 96, channel: "sms", templateKey: "estimate-followup-day8", gate: "financing_live" },
        templateBody: "monthly payment angle",
      },
      deps,
    );
    expect(res.sent).toBe(false);
    expect(sent).toHaveLength(0);
    const [comm] = await withTenant(tenantId, (tx) =>
      tx.select().from(communication)
        .where(and(eq(communication.customerId, customerId), eq(communication.direction, "outbound")))
        .orderBy(desc(communication.createdAt)).limit(1),
    );
    expect(comm!.body).toContain("[suppressed: gate financing_live]");
  });
});

describe("enrollment on send", () => {
  it("createEstimateSubmission enrolls the customer in the sequence", async () => {
    const emitted: { name: string; data: Record<string, unknown> }[] = [];
    __setDripEmitter(async (e) => { emitted.push(e as { name: string; data: Record<string, unknown> }); });

    // a fresh estimate that hasn't been sent through the submission path yet
    const m2 = await withTenant(tenantId, async (tx) => {
      const [p] = await tx.select({ id: property.id }).from(property).limit(1);
      const [m] = await tx.insert(measurement).values({ tenantId, propertyId: p!.id, provider: "roofr", areas: { squares: 15, predominantPitch: "4/12", eaveLf: 80, rakeLf: 40 } }).returning();
      return m!.id;
    });
    const est2 = await createEstimateFromMeasurement({ tenantId, leadId, measurementId: m2 });
    const res = await createEstimateSubmission(tenantId, est2!.id, makeFakeDocuseal());
    expect("submissionId" in res).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.name).toBe("drip/enroll");
    expect(emitted[0]!.data).toMatchObject({ dripKey: ESTIMATE_FOLLOWUP_DRIP_KEY, customerId, leadId });
  });
});
