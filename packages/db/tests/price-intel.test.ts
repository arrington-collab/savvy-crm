import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { adminDb } from "../src/admin-client.js";
import { customer, property, lead } from "../src/schema/crm.js";
import { estimate } from "../src/schema/finance.js";
import { competitor } from "../src/schema/competitor.js";
import { makeTenant } from "./helpers.js";
import { markLeadLostWithIntel, findOrCreateCompetitor, marketPricingSummary } from "../src/lifecycle/price-intel.js";

async function seedLead(tenantId: string, opts?: { city?: string; ourBidCents?: number }) {
  const [c] = await adminDb.insert(customer).values({ tenantId, name: `PI ${crypto.randomUUID().slice(0, 6)}` }).returning();
  const [p] = await adminDb.insert(property).values({
    tenantId, customerId: c!.id, address: `${crypto.randomUUID().slice(0, 6)} Intel Way`, city: opts?.city ?? "Mesa",
  }).returning();
  const [l] = await adminDb.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, source: "web", status: "qualified" }).returning();
  if (opts?.ourBidCents) {
    await adminDb.insert(estimate).values({ tenantId, leadId: l!.id, status: "sent", total: opts.ourBidCents });
  }
  return l!.id;
}

describe("findOrCreateCompetitor", () => {
  it("create-once with the same folding hygiene as partners", async () => {
    const { tenantId } = await makeTenant();
    const a = await findOrCreateCompetitor(tenantId, "Peak Roofing LLC");
    const b = await findOrCreateCompetitor(tenantId, "  peak   roofing  ");
    expect(b.id).toBe(a.id);
    expect(await adminDb.select().from(competitor).where(eq(competitor.tenantId, tenantId))).toHaveLength(1);
  });
});

describe("markLeadLostWithIntel", () => {
  it("plain lost still works — intel fields are OPTIONAL and never block", async () => {
    const { tenantId } = await makeTenant();
    const leadId = await seedLead(tenantId);
    await markLeadLostWithIntel(tenantId, { leadId });
    const [l] = await adminDb.select().from(lead).where(eq(lead.id, leadId));
    expect(l!.status).toBe("lost");
    expect(l!.lostReason).toBeNull();
  });

  it("reason=price captures competitor bid + create-once competitor name", async () => {
    const { tenantId } = await makeTenant();
    const leadId = await seedLead(tenantId);
    await markLeadLostWithIntel(tenantId, {
      leadId, reason: "price", competitorBidCents: 1_450_000, competitorName: "Peak Roofing LLC",
    });
    const [l] = await adminDb.select().from(lead).where(eq(lead.id, leadId));
    expect(l!.status).toBe("lost");
    expect(l!.lostReason).toBe("price");
    expect(l!.competitorBidCents).toBe(1_450_000);
    expect(l!.competitorId).toBeTruthy();
    const [comp] = await adminDb.select().from(competitor).where(eq(competitor.id, l!.competitorId!));
    expect(comp!.name).toBe("Peak Roofing LLC");
  });
});

describe("marketPricingSummary (quarterly artifact, n≥10 gate)", () => {
  it("returns null below 10 captures — no artifact from thin data", async () => {
    const { tenantId } = await makeTenant();
    for (let i = 0; i < 4; i++) {
      const leadId = await seedLead(tenantId, { ourBidCents: 1_500_000 });
      await markLeadLostWithIntel(tenantId, { leadId, reason: "price", competitorBidCents: 1_400_000, competitorName: `Comp ${i}` });
    }
    expect(await marketPricingSummary(tenantId, new Date())).toBeNull();
  });

  it("with 10+ captures: our bid vs theirs by area, capture rate as a stat (never a gate)", async () => {
    const { tenantId } = await makeTenant();
    for (let i = 0; i < 10; i++) {
      const leadId = await seedLead(tenantId, { city: i < 6 ? "Mesa" : "Gilbert", ourBidCents: 1_500_000 });
      await markLeadLostWithIntel(tenantId, {
        leadId, reason: "price", competitorBidCents: 1_350_000 + i * 10_000, competitorName: "Peak Roofing",
      });
    }
    // Two price-losses WITHOUT captured bids — they hurt capture rate, nothing else.
    for (let i = 0; i < 2; i++) {
      const leadId = await seedLead(tenantId, { ourBidCents: 1_500_000 });
      await markLeadLostWithIntel(tenantId, { leadId, reason: "price" });
    }

    const art = await marketPricingSummary(tenantId, new Date());
    expect(art).not.toBeNull();
    expect(art!.captures).toBe(10);
    expect(art!.captureRatePct).toBe(Math.round((10 / 12) * 100));
    const mesa = art!.byArea.find((a) => a.area === "Mesa")!;
    expect(mesa.captures).toBe(6);
    expect(mesa.avgOurBidCents).toBe(1_500_000);
    expect(mesa.avgCompetitorBidCents).toBeGreaterThan(0);
    expect(typeof mesa.avgDeltaPct).toBe("number"); // we're ~10% above in this seed
  });
});
