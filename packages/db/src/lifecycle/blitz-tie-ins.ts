import { and, desc, eq, gte, isNull, or, sql } from "drizzle-orm";
import { streetNameFromAddress } from "@savvy/core";
import { withTenant, type Tx } from "../tenant";
import { canvassTerritory, canvassKnock } from "../schema/canvass";
import { boostCard } from "../schema/boost";
import { customer } from "../schema/crm";
import { document } from "../schema/ops";

// Phase 26 slice 2: the blitz's canvass + Facebook tie-ins. Created inside the
// blitz transaction so a planned blitz ALWAYS has its territory and cards.

const METERS_PER_DEG_LAT = 111_320;

function diamondAround(lat: number, lng: number, radiusMeters: number): number[][] {
  const dLat = radiusMeters / METERS_PER_DEG_LAT;
  const dLng = radiusMeters / (METERS_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
  return [
    [lat + dLat, lng],
    [lat, lng + dLng],
    [lat - dLat, lng],
    [lat, lng - dLng],
  ];
}

function weekdayName(d: Date): string {
  return d.toLocaleDateString("en-US", { weekday: "long" });
}

export type BlitzTieInInput = {
  campaignId: string;
  jobId: string;
  customerId: string;
  site: { lat: number; lng: number; address: string };
  buildStart: Date;
  buildEnd: Date;
  radiusMeters: number;
};

/**
 * Territory + route context for the field app (active day-before through
 * build-end) and the two manual-trigger boost cards. Creative discipline:
 * street name never a house number, the customer is never named, and the job
 * photo rides along ONLY when marketing consent is on file (boost.consent
 * invariant — the red path this slice exists for).
 */
export async function createBlitzTieIns(tx: Tx, tenantId: string, input: BlitzTieInInput): Promise<void> {
  const street = streetNameFromAddress(input.site.address);
  const activeFrom = new Date(input.buildStart.getTime() - 86_400_000);

  const [existing] = await tx.select({ id: canvassTerritory.id }).from(canvassTerritory)
    .where(and(eq(canvassTerritory.tenantId, tenantId), eq(canvassTerritory.campaignId, input.campaignId)));
  if (!existing) {
    await tx.insert(canvassTerritory).values({
      tenantId,
      name: `Blitz — ${street}`,
      color: "#f59e0b",
      points: diamondAround(input.site.lat, input.site.lng, input.radiusMeters),
      jobId: input.jobId,
      campaignId: input.campaignId,
      activeFrom,
      activeUntil: input.buildEnd,
      context: `Roofing on ${street} through ${weekdayName(input.buildEnd)} — mobilization pricing while the crew's on-site.`,
    });
  }

  // Photo only with explicit consent; the copy never names the customer.
  const [cust] = await tx.select({ marketingConsentAt: customer.marketingConsentAt }).from(customer)
    .where(eq(customer.id, input.customerId));
  let photoDocumentId: string | null = null;
  if (cust?.marketingConsentAt) {
    const [photo] = await tx.select({ id: document.id }).from(document)
      .where(and(
        eq(document.tenantId, tenantId), eq(document.jobId, input.jobId),
        eq(document.kind, "photo"), eq(document.qcStatus, "passed"),
      ))
      .orderBy(desc(document.createdAt)).limit(1);
    photoDocumentId = photo?.id ?? null;
  }

  const copyFor = (kind: "day_before" | "day_of"): string =>
    kind === "day_before"
      ? `Your neighbor on ${street} is getting a new roof — our crew arrives tomorrow. Mobilization pricing for ${street} neighbors while the equipment's on-site.`
      : `We're roofing on ${street} today through ${weekdayName(input.buildEnd)}. Stop by or message us — neighbor pricing while the crew's here.`;

  for (const card of [
    { kind: "day_before" as const, scheduledFor: activeFrom },
    { kind: "day_of" as const, scheduledFor: input.buildStart },
  ]) {
    await tx.insert(boostCard).values({
      tenantId, campaignId: input.campaignId, jobId: input.jobId,
      kind: card.kind, scheduledFor: card.scheduledFor,
      copy: copyFor(card.kind), photoDocumentId,
    }).onConflictDoNothing();
  }
}

/** Field-app territory list: windowed blitz turf hides after build-end; manual turf lives forever. */
export async function listActiveTerritories(
  tenantId: string,
  now: Date,
): Promise<Array<{ id: string; clientId: string | null; name: string; color: string | null; points: number[][]; context: string | null }>> {
  return withTenant(tenantId, (tx) =>
    tx.select({
      id: canvassTerritory.id, clientId: canvassTerritory.clientId, name: canvassTerritory.name,
      color: canvassTerritory.color, points: canvassTerritory.points, context: canvassTerritory.context,
    }).from(canvassTerritory)
      .where(and(
        eq(canvassTerritory.tenantId, tenantId),
        or(isNull(canvassTerritory.activeUntil), gte(canvassTerritory.activeUntil, now)),
      )),
  );
}

/** Knocks/sales attribution: everything logged in the blitz's territory counts for the blitz. */
export async function blitzCanvassStats(tenantId: string, campaignId: string): Promise<{ knocks: number; sales: number }> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx.select({
      knocks: sql<number>`count(*)::int`,
      sales: sql<number>`sum(case when ${canvassKnock.outcome} = 'sale' then 1 else 0 end)::int`,
    }).from(canvassKnock)
      .innerJoin(canvassTerritory, eq(canvassKnock.territoryId, canvassTerritory.id))
      .where(and(eq(canvassKnock.tenantId, tenantId), eq(canvassTerritory.campaignId, campaignId)));
    return { knocks: Number(row?.knocks ?? 0), sales: Number(row?.sales ?? 0) };
  });
}

/** The card is a manual trigger — the human posts/boosts, then records the outcome. */
export async function resolveBoostCard(
  tenantId: string,
  input: { boostCardId: string; outcome: "boosted" | "skipped"; userId: string | null },
): Promise<{ resolved: boolean }> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx.update(boostCard)
      .set({ status: input.outcome, resolvedAt: new Date(), resolvedByUserId: input.userId })
      .where(and(eq(boostCard.tenantId, tenantId), eq(boostCard.id, input.boostCardId), eq(boostCard.status, "pending")))
      .returning({ id: boostCard.id });
    return { resolved: !!row };
  });
}

/** Due, unresolved boost cards for the /today card. */
export async function dueBoostCards(tenantId: string, now: Date): Promise<Array<{
  boostCardId: string; kind: string; copy: string; photoDocumentId: string | null; scheduledFor: Date;
}>> {
  return withTenant(tenantId, (tx) =>
    tx.select({
      boostCardId: boostCard.id, kind: boostCard.kind, copy: boostCard.copy,
      photoDocumentId: boostCard.photoDocumentId, scheduledFor: boostCard.scheduledFor,
    }).from(boostCard)
      .where(and(
        eq(boostCard.tenantId, tenantId), eq(boostCard.status, "pending"),
        sql`${boostCard.scheduledFor} <= ${now.toISOString()}::timestamptz`,
      )),
  );
}

/** Explicit, revocable marketing consent — the boost.consent invariant's source of truth. */
export async function setMarketingConsent(
  tenantId: string,
  input: { customerId: string; granted: boolean },
): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx.update(customer)
      .set({ marketingConsentAt: input.granted ? new Date() : null })
      .where(and(eq(customer.tenantId, tenantId), eq(customer.id, input.customerId))),
  );
}
