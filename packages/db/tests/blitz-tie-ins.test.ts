import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { evidenceChecks } from "@savvy/core";
import type { EvidenceCtx } from "@savvy/core";
import { adminDb, adminPool } from "../src/admin-client.js";
import { customer, property } from "../src/schema/crm.js";
import { job } from "../src/schema/jobs.js";
import { appointment } from "../src/schema/comms.js";
import { document } from "../src/schema/ops.js";
import { canvassTerritory, canvassKnock, canvassRep } from "../src/schema/canvass.js";
import { mailCampaign } from "../src/schema/mail.js";
import { boostCard } from "../src/schema/boost.js";
import { makeTenant, makeUser } from "./helpers.js";
import { buildMobilizationBlitz } from "../src/lifecycle/mobilization-blitz.js";
import { blitzCanvassStats, listActiveTerritories, resolveBoostCard, setMarketingConsent } from "../src/lifecycle/blitz-tie-ins.js";

const NOW = new Date();
const BUILD_START = new Date(NOW.getTime() + 5 * 86_400_000);
const BUILD_END = new Date(BUILD_START.getTime() + 2 * 86_400_000);
const SITE = { lat: 33.4152, lng: -111.8315 };

async function seedBlitz(tenantId: string, opts?: { consented?: boolean; withPhoto?: boolean }) {
  const { userId } = await makeUser(tenantId);
  const [c] = await adminDb.insert(customer).values({
    tenantId, name: "Consentina Homeowner",
    marketingConsentAt: opts?.consented ? NOW : null,
  }).returning();
  const [p] = await adminDb.insert(property).values({
    tenantId, customerId: c!.id, address: "100 Site St, Mesa AZ", lat: SITE.lat, lng: SITE.lng,
  }).returning();
  const [j] = await adminDb.insert(job).values({
    tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "approved",
  }).returning();
  await adminDb.insert(appointment).values({
    tenantId, jobId: j!.id, propertyId: p!.id, customerId: c!.id, type: "crew",
    assigneeUserId: userId, startsAt: BUILD_START, endsAt: BUILD_END, status: "scheduled",
  });
  let photoId: string | null = null;
  if (opts?.withPhoto) {
    const [d] = await adminDb.insert(document).values({
      tenantId, jobId: j!.id, kind: "photo", r2Key: `t/${j!.id}/photo.jpg`, qcStatus: "passed",
    }).returning();
    photoId = d!.id;
  }
  // A neighbor so the blitz has an audience.
  const [nc] = await adminDb.insert(customer).values({ tenantId, name: "Neighbor" }).returning();
  await adminDb.insert(property).values({
    tenantId, customerId: nc!.id, address: "104 Neighbor Ln, Mesa AZ", lat: SITE.lat + 0.001, lng: SITE.lng,
  });
  const r = await buildMobilizationBlitz(tenantId, { jobId: j!.id, now: NOW });
  if (!("campaignId" in r)) throw new Error(`expected campaign, got ${JSON.stringify(r)}`);
  return { campaignId: r.campaignId, jobId: j!.id, customerId: c!.id, photoId, userId };
}

describe("blitz canvass territory tie-in", () => {
  it("blitz creation pushes a territory around the job, active day-before through build-end, with job context", async () => {
    const { tenantId } = await makeTenant();
    const { campaignId, jobId } = await seedBlitz(tenantId);

    const terrs = await adminDb.select().from(canvassTerritory)
      .where(and(eq(canvassTerritory.tenantId, tenantId), eq(canvassTerritory.campaignId, campaignId)));
    expect(terrs).toHaveLength(1);
    const t = terrs[0]!;
    expect(t.jobId).toBe(jobId);
    expect(t.points.length).toBeGreaterThanOrEqual(4); // a polygon around the site
    expect(t.activeFrom!.getTime()).toBe(BUILD_START.getTime() - 86_400_000);
    expect(t.activeUntil!.getTime()).toBe(BUILD_END.getTime());
    expect(t.context).toContain("Site St"); // street context for the route
    expect(t.context).not.toContain("100 "); // never the house number
    expect(t.name).toContain("Blitz");
  });

  it("listActiveTerritories hides expired blitz territories from the field app but keeps manual ones", async () => {
    const { tenantId } = await makeTenant();
    const { campaignId } = await seedBlitz(tenantId);
    // A manual (non-windowed) territory stays visible forever.
    await adminDb.insert(canvassTerritory).values({
      tenantId, name: "Manual turf", points: [[SITE.lat, SITE.lng], [SITE.lat + 0.01, SITE.lng], [SITE.lat, SITE.lng + 0.01]],
    });

    const during = await listActiveTerritories(tenantId, new Date(BUILD_START.getTime()));
    expect(during.map((t) => t.name).some((n) => n.includes("Blitz"))).toBe(true);
    expect(during.map((t) => t.name)).toContain("Manual turf");

    const after = await listActiveTerritories(tenantId, new Date(BUILD_END.getTime() + 86_400_000));
    expect(after.map((t) => t.name).some((n) => n.includes("Blitz"))).toBe(false);
    expect(after.map((t) => t.name)).toContain("Manual turf");
    void campaignId;
  });

  it("knocks and sales in the blitz territory attribute to the campaign", async () => {
    const { tenantId } = await makeTenant();
    const { campaignId } = await seedBlitz(tenantId);
    const [terr] = await adminDb.select().from(canvassTerritory)
      .where(and(eq(canvassTerritory.tenantId, tenantId), eq(canvassTerritory.campaignId, campaignId)));
    const [rep] = await adminDb.insert(canvassRep).values({ tenantId, name: "Knocker", pinHash: "x" }).returning();
    await adminDb.insert(canvassKnock).values([
      { tenantId, repId: rep!.id, clientId: `k1-${crypto.randomUUID()}`, territoryId: terr!.id, lat: SITE.lat, lng: SITE.lng, outcome: "notint" },
      { tenantId, repId: rep!.id, clientId: `k2-${crypto.randomUUID()}`, territoryId: terr!.id, lat: SITE.lat, lng: SITE.lng, outcome: "sale" },
    ]);
    const stats = await blitzCanvassStats(tenantId, campaignId);
    expect(stats.knocks).toBe(2);
    expect(stats.sales).toBe(1);
  });
});

describe("Facebook boost cards", () => {
  it("day-before and day-of cards, street-level copy, photo attached ONLY with marketing consent", async () => {
    const { tenantId } = await makeTenant();
    const { campaignId, photoId } = await seedBlitz(tenantId, { consented: true, withPhoto: true });

    const cards = await adminDb.select().from(boostCard)
      .where(and(eq(boostCard.tenantId, tenantId), eq(boostCard.campaignId, campaignId)));
    expect(cards).toHaveLength(2);
    expect(new Set(cards.map((c) => c.kind))).toEqual(new Set(["day_before", "day_of"]));
    for (const c of cards) {
      expect(c.status).toBe("pending");
      expect(c.copy).toContain("Site St");
      expect(c.copy).not.toContain("100 "); // house numbers never appear
      expect(c.copy).not.toContain("Consentina"); // creatives never name the customer
      expect(c.photoDocumentId).toBe(photoId); // consented → photo rides along
    }
    const before = cards.find((c) => c.kind === "day_before")!;
    expect(before.scheduledFor.getTime()).toBe(BUILD_START.getTime() - 86_400_000);
  });

  it("red path: an unconsented customer's job gets copy-only cards — no photo, ever", async () => {
    const { tenantId } = await makeTenant();
    const { campaignId, jobId } = await seedBlitz(tenantId, { consented: false, withPhoto: true });
    const cards = await adminDb.select().from(boostCard)
      .where(and(eq(boostCard.tenantId, tenantId), eq(boostCard.campaignId, campaignId)));
    expect(cards).toHaveLength(2);
    expect(cards.every((c) => c.photoDocumentId === null)).toBe(true);

    const ctx: EvidenceCtx = {
      tenantId, db: adminPool, params: {},
      window: { start: new Date(NOW.getTime() - 86_400_000), end: new Date(NOW.getTime() + 86_400_000) },
    };
    expect((await evidenceChecks["boost.consent"]!(ctx)).status).toBe("pass");

    // Force the violation the invariant exists to catch.
    const [forced] = await adminDb.insert(document).values({
      tenantId, jobId, kind: "photo", r2Key: "forced/violation.jpg", qcStatus: "passed",
    }).returning();
    await adminDb.update(boostCard).set({ photoDocumentId: forced!.id }).where(eq(boostCard.id, cards[0]!.id));
    expect((await evidenceChecks["boost.consent"]!(ctx)).status).toBe("fail");
  });

  it("consent is grantable/revocable and the card records boosted or skipped with who", async () => {
    const { tenantId } = await makeTenant();
    const { campaignId, customerId, userId } = await seedBlitz(tenantId, { consented: false });
    await setMarketingConsent(tenantId, { customerId, granted: true });
    const [c] = await adminDb.select().from(customer).where(eq(customer.id, customerId));
    expect(c!.marketingConsentAt).toBeTruthy();

    const cards = await adminDb.select().from(boostCard)
      .where(and(eq(boostCard.tenantId, tenantId), eq(boostCard.campaignId, campaignId)));
    await resolveBoostCard(tenantId, { boostCardId: cards[0]!.id, outcome: "boosted", userId });
    await resolveBoostCard(tenantId, { boostCardId: cards[1]!.id, outcome: "skipped", userId });
    const after = await adminDb.select().from(boostCard)
      .where(and(eq(boostCard.tenantId, tenantId), eq(boostCard.campaignId, campaignId)));
    expect(new Set(after.map((x) => x.status))).toEqual(new Set(["boosted", "skipped"]));
    expect(after.every((x) => x.resolvedAt != null && x.resolvedByUserId === userId)).toBe(true);
  });
});
