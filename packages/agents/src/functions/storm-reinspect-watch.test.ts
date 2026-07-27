import { describe, it, expect } from "vitest";
import {
  adminDb, tenant, customer, property, lead, user, membership, stormReinspectBatch, relationshipTouch, suppress, eq, and,
  startInspectionForLead, completeInspection, approveInspection, publishInspection,
  proposeStormReinspectBatch, approveStormReinspectBatch,
} from "@savvy/db";
import { sweepTenantStormBaselines, sendStormReinspectOutreach } from "./storm-reinspect-watch.js";

const PHX_RING = [[33.3, -112.3], [33.6, -112.3], [33.6, -111.9], [33.3, -111.9]];

/** Baseline one more customer inside the swath for an existing tenant/owner. */
async function baselineCustomer(
  tenantId: string, userId: string, o: { name: string; phone: string; lat: number; lng: number },
) {
  const [c] = await adminDb.insert(customer).values({ tenantId, name: o.name, phone: o.phone, smsConsentAt: new Date("2026-01-01") }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: `${o.name} St`, lat: o.lat, lng: o.lng }).returning();
  const [l] = await adminDb.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, source: "web" }).returning();
  const started = await startInspectionForLead({ tenantId, leadId: l!.id });
  if ("error" in started) throw new Error("start failed");
  await completeInspection({ tenantId, inspectionId: started.inspectionId });
  await approveInspection({ tenantId, inspectionId: started.inspectionId, userId });
  await publishInspection({ tenantId, inspectionId: started.inspectionId });
  return { customerId: c!.id, phone: o.phone };
}

async function seedBaselined() {
  const [t] = await adminDb.insert(tenant).values({
    name: "StormWatch", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`,
    settings: { homeowner: { quietHours: { startHour: 0, endHour: 0 } } } as never,
  }).returning();
  const tenantId = t!.id;
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "Harper Homeowner", phone: "+16025550888", smsConsentAt: new Date("2026-01-01") }).returning();
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

  it("contacts active members FIRST — the top Strike List tier (#309)", async () => {
    // Seed a bare tenant + owner (no baselined customers yet).
    const [t] = await adminDb.insert(tenant).values({
      name: "StrikeCo", publicKey: `pk-${crypto.randomUUID()}`, clerkOrgId: `org-${crypto.randomUUID()}`,
      settings: { homeowner: { quietHours: { startHour: 0, endHour: 0 } } } as never,
    }).returning();
    const tenantId = t!.id;
    const [u] = await adminDb.insert(user).values({ tenantId, clerkUserId: `clk-${crypto.randomUUID()}`, name: "Owner", email: `o-${crypto.randomUUID()}@t.local`, role: "admin" }).returning();

    // Non-member inserted FIRST (heap order would contact them first without the tier sort)…
    const nonMember = await baselineCustomer(tenantId, u!.id, { name: "Nora Nonmember", phone: "+16025550001", lat: 33.44, lng: -112.06 });
    // …member inserted SECOND, but holds an active membership.
    const member = await baselineCustomer(tenantId, u!.id, { name: "Mona Member", phone: "+16025550002", lat: 33.46, lng: -112.08 });
    await adminDb.insert(membership).values({
      tenantId, customerId: member.customerId, status: "active", annualPriceCents: 34800, source: "manual", startedAt: new Date(),
    });

    const proposed = await proposeStormReinspectBatch({
      tenantId, swath: { kind: "hail", rings: [PHX_RING], size: 1.5, windMph: null, date: "2026-07-12" },
    });
    const batchId = (proposed as { batchId: string }).batchId;
    await approveStormReinspectBatch({ tenantId, batchId, userId: u!.id });

    const sent: { to: string }[] = [];
    const deps = {
      getTenantSms: (async () => ({
        sender: { sendSms: async (m: { to: string }) => { sent.push(m); return { providerId: "fake" }; } },
        from: "+15555550000",
      })) as never,
    };

    const res = await sendStormReinspectOutreach({ tenantId, batchId }, deps as never);
    expect(res).toEqual({ sent: 2 });
    // The member is reached before the non-member — invariant: member ∩ swath first.
    expect(sent.map((m) => m.to)).toEqual([member.phone, nonMember.phone]);
  });

  // Compliance follow-up: sendStormReinspectOutreach previously called
  // sender.sendSms directly, bypassing the global contact_suppression list.
  // Proves guardedSms is wired: a consented, non-opted-out homeowner who is
  // globally suppressed is NOT texted, and their relationship-calendar touch
  // is never flipped to sent.
  it("globally suppressed homeowner → not texted, touch stays unsent", async () => {
    const { tenantId, userId } = await seedBaselined();
    await suppress({ tenantId, phoneE164: "+16025550888", channel: "sms", reason: "stop", source: "test" });

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
    expect(res).toEqual({ sent: 0 });
    expect(sent).toHaveLength(0);

    const touches = await adminDb.select().from(relationshipTouch)
      .where(and(eq(relationshipTouch.tenantId, tenantId), eq(relationshipTouch.program, "storm_check")));
    expect(touches).toHaveLength(1);
    expect(touches[0]!.sentAt).toBeNull();

    const [batch] = await adminDb.select().from(stormReinspectBatch).where(eq(stormReinspectBatch.id, batchId));
    expect(batch!.status).toBe("sent"); // batch still flips — a blocked recipient doesn't stall the sweep
  });
});
