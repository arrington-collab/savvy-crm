import "server-only";
import {
  ballparkRange,
  resolveRoofSize,
  perSquareFromPriceBook,
  parseBallparkConfig,
  subjectToInspectionLine,
} from "@savvy/core";
import { withTenant, lead, property, priceBookItem, claim, tenant, eq, and, logBallparkQuote } from "@savvy/db";

export type LeadBallpark = {
  lowCents: number;
  highCents: number;
  confidence: "high" | "medium" | "low";
  basis: string;
  line: string;
};

/**
 * Compute an honest ballpark range for a lead from its property's roof data +
 * the tenant's price book + config. Returns null when the feature is off, the
 * lead is a claim, there is no roof size, or the basis is below the confidence
 * floor. Read-only (does NOT log) — callers that actually speak/send a quote
 * call `computeAndLogLeadBallpark`.
 */
export async function computeLeadBallpark(tenantId: string, leadId: string): Promise<LeadBallpark | null> {
  const data = await withTenant(tenantId, async (tx) => {
    const [l] = await tx.select({ propertyId: lead.propertyId }).from(lead).where(eq(lead.id, leadId));
    if (!l?.propertyId) return null;
    const [p] = await tx.select({ roofSqft: property.roofSqft, roofType: property.roofType }).from(property).where(eq(property.id, l.propertyId));
    const items = await tx
      .select({ unit: priceBookItem.unit, unitPriceCents: priceBookItem.unitPriceCents, unitCostCents: priceBookItem.unitCostCents })
      .from(priceBookItem)
      .where(eq(priceBookItem.active, true));
    const [cl] = await tx.select({ id: claim.id }).from(claim).where(and(eq(claim.leadId, leadId), eq(claim.tenantId, tenantId))).limit(1);
    const [t] = await tx.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
    return { p, items, isClaim: !!cl, settings: t?.settings };
  });
  if (!data?.p) return null;

  const config = parseBallparkConfig((data.settings as { ballpark?: unknown } | undefined)?.ballpark);
  // v1 size source: assessor roof sqft (measurement integration is a fast-follow).
  const size = resolveRoofSize({ measurementSquares: null, assessorRoofSqft: data.p.roofSqft, footprintSqft: null, roofType: data.p.roofType });
  const sell = perSquareFromPriceBook(data.items);
  const r = ballparkRange({ size, sell, config, isClaim: data.isClaim });
  if (!r) return null;
  return { ...r, line: subjectToInspectionLine(r.lowCents, r.highCents) };
}

/** Same as computeLeadBallpark, but logs the quote (inputs snapshot) when one is produced. */
export async function computeAndLogLeadBallpark(tenantId: string, leadId: string): Promise<LeadBallpark | null> {
  const r = await computeLeadBallpark(tenantId, leadId);
  if (r) {
    await logBallparkQuote(tenantId, {
      leadId,
      lowCents: r.lowCents,
      highCents: r.highCents,
      confidence: r.confidence,
      basis: r.basis,
      inputs: { basis: r.basis },
    });
  }
  return r;
}
