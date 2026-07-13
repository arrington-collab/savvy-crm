import { describe, it, expect, beforeAll } from "vitest";
import { customer, property, lead, user, measurement, tierProduct, withTenant } from "@savvy/db";
import { ensureTenantForOrg, ensurePriceBook, ensureTierProducts } from "@savvy/db";
import { createEstimateFromMeasurement, setEstimateStatus, recordEstimateEvent, listEstimateEvents } from "@savvy/db";
import { answerEstimateQuestion } from "./estimate-qa";

let tenantId: string;
let estimateId: string;
let sent: { to: string; body: string }[] = [];

const fakeSms = {
  getTenantSms: async () => ({
    sender: { sendSms: async (o: { to: string; body: string }) => { sent.push(o); return { sid: "mock" }; } },
    from: "+15550000000",
  }),
};
const confidentAi = {
  completeObject: async () => ({ object: { answer: "Your Better option includes the IKO Dynasty shingle with its lifetime warranty.", confidence: 0.92 }, model: "stub" }),
};
const unsureAi = {
  completeObject: async () => ({ object: { answer: "", confidence: 0.2 }, model: "stub" }),
};

beforeAll(async () => {
  const t = await ensureTenantForOrg({ clerkOrgId: `org_qa_${Date.now()}`, name: "QA Test" });
  tenantId = t.id;
  await ensurePriceBook(tenantId);
  await ensureTierProducts(tenantId);
  await withTenant(tenantId, (tx) => tx.update(tierProduct).set({ unitPriceCents: 20000, unitCostCents: 12000 }));
  const ids = await withTenant(tenantId, async (tx) => {
    const [rep] = await tx.insert(user).values({ tenantId, name: "QA Rep", email: `qarep-${Date.now()}@e2e.test`, role: "rep", phone: "+16025550444" }).returning();
    const [c] = await tx.insert(customer).values({ tenantId, name: "Curious Homeowner", phone: "+16025550555" }).returning();
    const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: "3 QA Ct", city: "Phoenix", state: "AZ" }).returning();
    const [l] = await tx.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, source: "referral", status: "qualified", assignedUserId: rep!.id }).returning();
    const [m] = await tx.insert(measurement).values({ tenantId, propertyId: p!.id, provider: "roofr", areas: { squares: 20, predominantPitch: "6/12", eaveLf: 100, rakeLf: 50 } }).returning();
    return { leadId: l!.id, measurementId: m!.id };
  });
  const est = await createEstimateFromMeasurement({ tenantId, leadId: ids.leadId, measurementId: ids.measurementId });
  estimateId = est!.id;
  await setEstimateStatus({ tenantId, estimateId, status: "sent" });
});

describe("answerEstimateQuestion", () => {
  it("answers grounded questions and logs the exchange as objection data", async () => {
    const res = await answerEstimateQuestion(
      { tenantId, estimateId, sessionId: "qa-1", question: "What warranty comes with the middle option?" },
      { ai: confidentAi, ...fakeSms },
    );
    expect(res.escalated).toBe(false);
    expect(res.answer).toContain("Dynasty");
    const events = await listEstimateEvents(tenantId, estimateId);
    const q = events.find((e) => e.kind === "question");
    expect(q).toBeDefined();
    expect((q!.meta as { question: string }).question).toContain("warranty");
  });

  it("below-confidence answers escalate to the rep instead of inventing", async () => {
    sent = [];
    const res = await answerEstimateQuestion(
      { tenantId, estimateId, sessionId: "qa-2", question: "Can you also rebuild my chimney?" },
      { ai: unsureAi, ...fakeSms },
    );
    expect(res.escalated).toBe(true);
    expect(res.answer.toLowerCase()).toContain("project manager");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("+16025550444");
    expect(sent[0]!.body).toContain("chimney");
    const events = await listEstimateEvents(tenantId, estimateId);
    expect(events.some((e) => e.kind === "question_escalated")).toBe(true);
  });

  it("rate-limits a chatty session (max 5 questions)", async () => {
    for (let i = 0; i < 5; i++) {
      await recordEstimateEvent({ tenantId, estimateId, kind: "question", sessionId: "qa-flood" });
    }
    const res = await answerEstimateQuestion(
      { tenantId, estimateId, sessionId: "qa-flood", question: "one more?" },
      { ai: confidentAi, ...fakeSms },
    );
    expect(res.escalated).toBe(false);
    expect(res.rateLimited).toBe(true);
  });
});
