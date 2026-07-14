import { describe, it, expect } from "vitest";
import {
  adminDb, tenant, customer, property, lead, user, stormReinspectBatch, eq,
  startInspectionForLead, completeInspection, approveInspection, publishInspection,
  proposeStormReinspectBatch, approveStormReinspectBatch,
} from "@savvy/db";
import { sweepTenantStormBaselines, sendStormReinspectOutreach } from "./storm-reinspect-watch.js";

const PHX_RING = [[33.3, -112.3], [33.6, -112.3], [33.6, -111.9], [33.3, -111.9]];

async function seedBaselined() {
  const [t] = await adminDb.insert(tenant).values({
    name: "StormWatch", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`,
    settings: { homeowner: { quietHours: { startHour: 0, endHour: 0 } } } as never,
  }).returning();
  const tenantId = t!.id;
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "Harper Homeowner", phone: "+16025550888" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "5 Baseline Blvd", lat: 33.45, lng: -112.07 }).returning();
  const [l] = await adminDb.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, source: "web" }).returning();
  const [u] = await adminDb.insert(user).values({ tenantId, clerkUserId: `clk-${crypto.randomUUID()}`, name: "Owner", email: `o-${crypto.randomUUID()}@t.local`, role: "admin" }).returning();
  const started = await startInspectionForLead({ tenantId, leadId: l!.id });
  if ("error" in started) throw new Error("start failed");
  await completeInspection({ tenantId, inspectionId: started.inspectionId });
  await approveInspection({ tenantId, inspectionId: started.inspectionId, userId: u!.id });
  await publishInspection({ tenantId, inspectionId: started.inspectionId });
  return { tenantId, userId: u!.id };
}

describe("sweepTenantStormBaselines", () => {
  it("cards a verified swath over baselined roofs exactly once across runs", async () => {
    const { tenantId } = await seedBaselined();
    const lookup = async () => [{
      eventType: "hail", rings: [PHX_RING], size: 1.5, windMph: null,
      date: new Date().toISOString().slice(0, 10),
    }] as never;

    const first = await sweepTenantStormBaselines(tenantId, { lookup: lookup as never });
    expect(first.proposed).toBe(1);
    const again = await sweepTenantStormBaselines(tenantId, { lookup: lookup as never });
    expect(again.proposed).toBe(0); // signature dedupe — the same event never cards twice
  });
});

describe("sendStormReinspectOutreach", () => {
  it("sends the service-framed template per affected roof and flips the batch to sent", async () => {
    const { tenantId, userId } = await seedBaselined();
    const proposed = await proposeStormReinspectBatch({
      tenantId,
      swath: { kind: "hail", rings: [PHX_RING], size: 1.5, windMph: null, date: "2026-07-12" },
    });
    const batchId = (proposed as { batchId: string }).batchId;
    await approveStormReinspectBatch({ tenantId, batchId, userId });

    const sent: { to: string; body: string }[] = [];
    const deps = {
      getTenantSms: (async () => ({
        sender: { sendSms: async (m: { to: string; body: string }) => { sent.push(m); return { providerId: "fake" }; } },
        from: "+15555550000",
      })) as never,
    };

    const res = await sendStormReinspectOutreach({ tenantId, batchId }, deps as never);
    expect(res).toEqual({ sent: 1 });
    expect(sent[0]!.to).toBe("+16025550888");
    expect(sent[0]!.body).toContain("Harper");
    expect(sent[0]!.body).toContain("baseline");
    expect(sent[0]!.body).not.toMatch(/act now|urgent|deal|discount/i); // service framing, never sales

    const [batch] = await adminDb.select().from(stormReinspectBatch).where(eq(stormReinspectBatch.id, batchId));
    expect(batch!.status).toBe("sent");

    // A replayed event is a no-op: the batch already left 'approved'.
    const replay = await sendStormReinspectOutreach({ tenantId, batchId }, deps as never);
    expect(replay).toEqual({ skipped: "not_approved" });
    expect(sent).toHaveLength(1);
  });
});
