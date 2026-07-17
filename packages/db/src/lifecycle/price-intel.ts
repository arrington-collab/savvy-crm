import { and, desc, eq, gte, isNotNull, lt } from "drizzle-orm";
import { normalizePartnerName, quarterKeyInTimeZone, priorQuarterKey, quarterRange } from "@savvy/core";
import { withTenant } from "../tenant";
import { adminDb } from "../admin-client";
import { competitor } from "../schema/competitor";
import { lead, property } from "../schema/crm";
import { estimate } from "../schema/finance";
import { tenant as tenantTbl } from "../schema/tenancy";

// Phase 26 slice 4 (#349/#350) — win/loss price intel. The capture is a
// 10-second OPTIONAL entry on the lost flow: it never blocks closing a lead.

export const LOST_REASONS = ["price", "timing", "went_dark", "not_interested", "other"] as const;
export type LostReason = (typeof LOST_REASONS)[number];

/** Create-once competitor, folded like partners ("Peak Roofing LLC" == "peak roofing"). */
export async function findOrCreateCompetitor(tenantId: string, name: string): Promise<{ id: string; created: boolean }> {
  return withTenant(tenantId, async (tx) => {
    const key = normalizePartnerName(name);
    const [existing] = await tx.select({ id: competitor.id }).from(competitor)
      .where(and(eq(competitor.tenantId, tenantId), eq(competitor.normalizedKey, key)));
    if (existing) return { id: existing.id, created: false };
    const [row] = await tx.insert(competitor).values({ tenantId, name: name.trim(), normalizedKey: key })
      .onConflictDoNothing().returning({ id: competitor.id });
    if (!row) {
      const [raced] = await tx.select({ id: competitor.id }).from(competitor)
        .where(and(eq(competitor.tenantId, tenantId), eq(competitor.normalizedKey, key)));
      return { id: raced!.id, created: false };
    }
    return { id: row.id, created: true };
  });
}

/**
 * Mark lost with optional intel. Every field is optional — a bare call is the
 * old setLeadLost. When reason=price the competitor bid and name (create-once)
 * ride along; nothing here can block the close.
 */
export async function markLeadLostWithIntel(
  tenantId: string,
  input: { leadId: string; reason?: LostReason; competitorBidCents?: number; competitorName?: string; competitorId?: string },
): Promise<void> {
  let competitorId = input.competitorId ?? null;
  if (!competitorId && input.competitorName?.trim()) {
    competitorId = (await findOrCreateCompetitor(tenantId, input.competitorName)).id;
  }
  await withTenant(tenantId, (tx) =>
    tx.update(lead).set({
      status: "lost",
      lostAt: new Date(),
      lostReason: input.reason ?? null,
      competitorBidCents: input.competitorBidCents ?? null,
      competitorId,
    }).where(and(eq(lead.tenantId, tenantId), eq(lead.id, input.leadId))),
  );
}

export type MarketPricingArtifact = {
  quarterKey: string;
  captures: number;
  priceLosses: number;
  captureRatePct: number; // a target, never a gate
  byArea: Array<{ area: string; captures: number; avgOurBidCents: number; avgCompetitorBidCents: number; avgDeltaPct: number | null }>;
};

/**
 * The quarterly market-pricing artifact (#350): our bid vs captured competitor
 * bids by area, from the trailing quarter's price-losses. Emits NOTHING below
 * 10 captures — thin data would invent a market read that isn't there.
 */
export async function marketPricingSummary(tenantId: string, now: Date): Promise<MarketPricingArtifact | null> {
  const [t] = await adminDb.select({ timezone: tenantTbl.timezone }).from(tenantTbl).where(eq(tenantTbl.id, tenantId));
  const tz = t?.timezone ?? "America/Phoenix";
  const currentQ = quarterKeyInTimeZone(now, tz);
  // Trailing window = the current quarter-to-date plus the prior quarter, so
  // the artifact reads a full season rather than a partial quarter's sliver.
  const window = { start: quarterRange(priorQuarterKey(currentQ), tz).start, end: quarterRange(currentQ, tz).end };

  return withTenant(tenantId, async (tx) => {
    const losses = await tx.select({
      leadId: lead.id, competitorBidCents: lead.competitorBidCents, city: property.city,
    }).from(lead)
      .leftJoin(property, eq(lead.propertyId, property.id))
      .where(and(
        eq(lead.tenantId, tenantId), eq(lead.status, "lost"), eq(lead.lostReason, "price"),
        isNotNull(lead.lostAt), gte(lead.lostAt, window.start), lt(lead.lostAt, window.end),
      ));
    const priceLosses = losses.length;
    const captured = losses.filter((l) => l.competitorBidCents != null);
    if (captured.length < 10) return null;

    const leadIds = captured.map((l) => l.leadId);
    const bids = await tx.select({ leadId: estimate.leadId, total: estimate.total, createdAt: estimate.createdAt })
      .from(estimate)
      .where(and(eq(estimate.tenantId, tenantId), isNotNull(estimate.total)))
      .orderBy(desc(estimate.createdAt));
    const ourBidByLead = new Map<string, number>();
    for (const b of bids) {
      if (b.leadId && leadIds.includes(b.leadId) && !ourBidByLead.has(b.leadId) && b.total != null) {
        ourBidByLead.set(b.leadId, b.total);
      }
    }

    const areas = new Map<string, { ours: number[]; theirs: number[] }>();
    for (const l of captured) {
      const area = l.city ?? "Unknown";
      const bucket = areas.get(area) ?? { ours: [], theirs: [] };
      const our = ourBidByLead.get(l.leadId);
      if (our != null) bucket.ours.push(our);
      bucket.theirs.push(l.competitorBidCents!);
      areas.set(area, bucket);
    }
    const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : 0);

    return {
      quarterKey: currentQ,
      captures: captured.length,
      priceLosses,
      captureRatePct: priceLosses > 0 ? Math.round((captured.length / priceLosses) * 100) : 0,
      byArea: [...areas.entries()].map(([area, b]) => {
        const avgOurBidCents = avg(b.ours);
        const avgCompetitorBidCents = avg(b.theirs);
        return {
          area, captures: b.theirs.length, avgOurBidCents, avgCompetitorBidCents,
          avgDeltaPct: avgOurBidCents > 0 && avgCompetitorBidCents > 0
            ? Math.round(((avgOurBidCents - avgCompetitorBidCents) / avgCompetitorBidCents) * 100)
            : null,
        };
      }).sort((a, b) => b.captures - a.captures),
    };
  });
}
