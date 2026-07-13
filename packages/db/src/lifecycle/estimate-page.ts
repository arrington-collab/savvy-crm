// Estimate Experience slice 2: tokenized estimate page — link minting and the
// homeowner's tier/color selection. The page route itself lives in apps/web;
// this is the DB truth those routes call.

import { and, eq } from "drizzle-orm";
import { createHmac } from "node:crypto";
import { withTenant } from "../tenant";
import { adminDb } from "../admin-client";
import { bookingLink } from "../schema/booking-link";
import { estimate } from "../schema/finance";
import { tierProduct } from "../schema/pricing";
import { randomShortCode, type TierEstimate } from "@savvy/core";

// Deterministic per-estimate token (estimateId + HMAC) so ensureEstimateLink is
// naturally idempotent (same estimate → same token → one row) and resolution is
// O(1): parse the id out, verify the signature. Same secret family as the other
// homeowner links.
function estimateSig(tenantId: string, estimateId: string): string {
  const secret = process.env.UNSUBSCRIBE_SECRET ?? "dev-unsubscribe-secret";
  return createHmac("sha256", secret).update(`estimate:${tenantId}:${estimateId}`).digest("base64url").slice(0, 24);
}

export function estimateLinkToken(tenantId: string, estimateId: string): string {
  return `${estimateId}.${estimateSig(tenantId, estimateId)}`;
}

/** Mints (or returns) THE tokenized page link for an estimate. Idempotent. */
export async function ensureEstimateLink(input: {
  tenantId: string;
  estimateId: string;
}): Promise<{ code: string }> {
  const token = estimateLinkToken(input.tenantId, input.estimateId);
  const [existing] = await adminDb
    .select({ code: bookingLink.code })
    .from(bookingLink)
    .where(
      and(
        eq(bookingLink.tenantId, input.tenantId),
        eq(bookingLink.kind, "estimate"),
        eq(bookingLink.token, token),
      ),
    );
  if (existing) return { code: existing.code };

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomShortCode();
    try {
      await adminDb.insert(bookingLink).values({ tenantId: input.tenantId, code, token, kind: "estimate" });
      return { code };
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("23505")) continue;
      throw err;
    }
  }
  throw new Error("Failed to generate unique estimate link code after 5 attempts");
}

/** Resolves a public page code back to the estimate it fronts. Null when the
 *  code is unknown, tampered, or not an estimate link. */
export async function resolveEstimateLink(
  code: string,
): Promise<{ tenantId: string; estimateId: string } | null> {
  const [row] = await adminDb
    .select({ tenantId: bookingLink.tenantId, token: bookingLink.token, kind: bookingLink.kind })
    .from(bookingLink)
    .where(eq(bookingLink.code, code));
  if (!row || row.kind !== "estimate") return null;

  const [estimateId, sig] = row.token.split(".");
  if (!estimateId || !sig || estimateSig(row.tenantId, estimateId) !== sig) return null;
  return { tenantId: row.tenantId, estimateId };
}

/** The homeowner's tier/color pick from the page. Validates against the tier
 *  snapshot and that tier's live palette — never trusts the client. */
export async function setEstimateSelection(input: {
  tenantId: string;
  estimateId: string;
  tier: "good" | "better" | "best";
  color: string;
}): Promise<{ ok: true } | { ok: false; error: "invalid_tier" | "invalid_color" | "not_found" }> {
  return withTenant(input.tenantId, async (tx) => {
    const [est] = await tx.select().from(estimate).where(eq(estimate.id, input.estimateId));
    if (!est) return { ok: false, error: "not_found" as const };

    const tiers = (est.tiers ?? []) as unknown as TierEstimate[];
    if (!tiers.some((t) => t.tier === input.tier)) return { ok: false, error: "invalid_tier" as const };

    const [product] = await tx
      .select({ colorPalette: tierProduct.colorPalette })
      .from(tierProduct)
      .where(eq(tierProduct.tier, input.tier));
    const palette = product?.colorPalette ?? [];
    if (!palette.some((c) => c.name === input.color)) return { ok: false, error: "invalid_color" as const };

    await tx
      .update(estimate)
      .set({ selectedTier: input.tier, selectedColor: input.color })
      .where(eq(estimate.id, input.estimateId));
    return { ok: true as const };
  });
}

/** Everything the public estimate page needs, in one tenant-scoped read. */
export async function getEstimatePageData(tenantId: string, estimateId: string) {
  const { customer, property } = await import("../schema/crm");
  const { tenant } = await import("../schema/tenancy");
  const { license } = await import("../schema/compliance");
  const { document } = await import("../schema/ops");
  const { or, and: andOp, eq: eqOp } = await import("drizzle-orm");

  return withTenant(tenantId, async (tx) => {
    const [est] = await tx.select().from(estimate).where(eq(estimate.id, estimateId));
    if (!est) return null;

    const [t] = await tx.select({ name: tenant.name, settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
    // The customer hangs off the lead (lead-stage) or the job (post-accept).
    let customerId: string | null = null;
    if (est.leadId) {
      const { lead } = await import("../schema/crm");
      const [l] = await tx.select({ customerId: lead.customerId }).from(lead).where(eq(lead.id, est.leadId));
      customerId = l?.customerId ?? null;
    } else if (est.jobId) {
      const { job } = await import("../schema/jobs");
      const [j] = await tx.select({ customerId: job.customerId }).from(job).where(eq(job.id, est.jobId));
      customerId = j?.customerId ?? null;
    }
    const [cust] = customerId
      ? await tx.select({ name: customer.name }).from(customer).where(eq(customer.id, customerId))
      : [null];
    const [prop] = est.propertyId
      ? await tx.select({ address: property.address, city: property.city, state: property.state }).from(property).where(eq(property.id, est.propertyId))
      : [null];
    const licenses = await tx
      .select({ state: license.state, city: license.city, licenseNumber: license.licenseNumber })
      .from(license)
      .where(eq(license.status, "active"))
      .catch(() => []);
    const products = await tx.select().from(tierProduct).where(eq(tierProduct.active, true));

    // Homeowner-visible photos: QC-passed only. (The dedicated customer-safe
    // flag arrives with Production Pulse — until then QC-passed is the gate.)
    const scope = or(
      est.leadId ? eqOp(document.leadId, est.leadId) : undefined,
      est.jobId ? eqOp(document.jobId, est.jobId) : undefined,
    );
    const photos = scope
      ? await tx
          .select({ id: document.id, label: document.label, mime: document.mime, r2Key: document.r2Key })
          .from(document)
          .where(andOp(eqOp(document.kind, "photo"), eqOp(document.qcStatus, "passed"), scope))
      : [];

    return { estimate: est, companyName: t?.name ?? "", settings: t?.settings, customerName: cust?.name ?? null, property: prop ?? null, licenses, products, photos: photos.filter((p) => p.r2Key) };
  });
}
