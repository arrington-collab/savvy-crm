import { and, eq, inArray } from "drizzle-orm";
import { monthlyEquivalentCents, parseMaintenanceConfig } from "@savvy/core";
import { withTenant } from "../tenant";
import { adminDb } from "../admin-client";
import { customer } from "../schema/crm";
import { membership } from "../schema/membership";
import { tenant as tenantTbl } from "../schema/tenancy";

// Phase 20 (#305) — membership lifecycle. Stripe recurring is the rail;
// activation happens ONLY from the checkout webhook (a membership can never
// be active without a live Stripe subscription), and cancellation always
// carries a tagged reason for the churn watch (#310).

type SubscriptionStripe = {
  createSubscriptionCheckout(o: {
    connectedAccountId: string; annualAmountCents: number; tenantId: string; membershipId: string;
    description: string; successUrl: string; cancelUrl: string; customerEmail?: string;
  }): Promise<{ id: string; url: string; subscriptionId: string | null }>;
  cancelSubscription(o: { connectedAccountId: string; subscriptionId: string }): Promise<{ canceled: boolean }>;
};

export async function startMembershipCheckout(
  tenantId: string,
  input: { customerId: string; stripe: SubscriptionStripe; baseUrl?: string; source?: string },
): Promise<{ url: string; membershipId: string } | { error: string; membershipId: string }> {
  const [t] = await adminDb.select({ settings: tenantTbl.settings, stripeAccountId: tenantTbl.stripeAccountId })
    .from(tenantTbl).where(eq(tenantTbl.id, tenantId));
  const cfg = parseMaintenanceConfig((t?.settings as { maintenance?: unknown } | null)?.maintenance);

  return withTenant(tenantId, async (tx) => {
    const [cust] = await tx.select({ email: customer.email, name: customer.name })
      .from(customer).where(eq(customer.id, input.customerId));

    // One live membership per customer — reuse the open row instead of stacking.
    const [existing] = await tx.select().from(membership).where(and(
      eq(membership.tenantId, tenantId), eq(membership.customerId, input.customerId),
      inArray(membership.status, ["draft", "pending", "active", "past_due"]),
    ));

    // Fail-soft (cert-lane pattern): no payment rail ⇒ draft, never fake-active.
    if (!t?.stripeAccountId) {
      const membershipId = existing?.id ?? (await tx.insert(membership).values({
        tenantId, customerId: input.customerId, status: "draft", annualPriceCents: cfg.annualPriceCents,
        source: input.source ?? "manual",
      }).returning({ id: membership.id }))[0]!.id;
      return { error: "stripe not connected — membership parked as draft", membershipId };
    }

    const membershipId = existing?.id ?? (await tx.insert(membership).values({
      tenantId, customerId: input.customerId, status: "pending", annualPriceCents: cfg.annualPriceCents,
      source: input.source ?? "manual",
    }).returning({ id: membership.id }))[0]!.id;

    const base = input.baseUrl ?? process.env.APP_BASE_URL ?? "http://localhost:3000";
    const session = await input.stripe.createSubscriptionCheckout({
      connectedAccountId: t.stripeAccountId,
      annualAmountCents: cfg.annualPriceCents,
      tenantId, membershipId,
      description: "Annual Roof Maintenance Membership",
      successUrl: `${base}/membership/confirmed`,
      cancelUrl: `${base}/membership/canceled`,
      customerEmail: cust?.email ?? undefined,
    });
    await tx.update(membership).set({ status: "pending", checkoutSessionId: session.id, updatedAt: new Date() })
      .where(eq(membership.id, membershipId));
    return { url: session.url, membershipId };
  });
}

/** Webhook handler body: checkout.session.completed (mode=subscription). */
export async function activateMembershipFromCheckout(
  tenantId: string,
  input: { checkoutSessionId: string; stripeSubscriptionId: string; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const rows = await withTenant(tenantId, (tx) =>
    tx.update(membership).set({
      status: "active", stripeSubscriptionId: input.stripeSubscriptionId, startedAt: now, updatedAt: now,
    }).where(and(
      eq(membership.tenantId, tenantId), eq(membership.checkoutSessionId, input.checkoutSessionId),
      inArray(membership.status, ["pending", "past_due"]),
    )).returning({ id: membership.id }));
  return rows.length > 0;
}

/** Cancel with a REQUIRED tagged reason — the churn watch reads these. */
export async function cancelMembership(
  tenantId: string,
  input: { membershipId: string; reason: string; stripe: SubscriptionStripe; now?: Date },
): Promise<{ ok: true } | { error: string }> {
  if (!input.reason.trim()) return { error: "reason required" };
  const now = input.now ?? new Date();
  const [t] = await adminDb.select({ stripeAccountId: tenantTbl.stripeAccountId })
    .from(tenantTbl).where(eq(tenantTbl.id, tenantId));

  const row = await withTenant(tenantId, async (tx) => {
    const [m] = await tx.select().from(membership)
      .where(and(eq(membership.tenantId, tenantId), eq(membership.id, input.membershipId)));
    return m ?? null;
  });
  if (!row) return { error: "not found" };

  if (row.stripeSubscriptionId && t?.stripeAccountId) {
    await input.stripe.cancelSubscription({
      connectedAccountId: t.stripeAccountId, subscriptionId: row.stripeSubscriptionId,
    });
  }
  await withTenant(tenantId, (tx) =>
    tx.update(membership).set({
      status: "canceled", canceledAt: now, cancellationReason: input.reason.trim(), updatedAt: now,
    }).where(eq(membership.id, row.id)));
  return { ok: true };
}

/** Monthly-equivalent recurring cents from ACTIVE memberships only. */
export async function maintenanceMrrCents(tenantId: string): Promise<number> {
  const rows = await withTenant(tenantId, (tx) =>
    tx.select({ annualPriceCents: membership.annualPriceCents }).from(membership)
      .where(and(eq(membership.tenantId, tenantId), eq(membership.status, "active"))));
  return rows.reduce((s, r) => s + monthlyEquivalentCents(r.annualPriceCents), 0);
}

/** Has this tenant ever touched the product? (valuation honesty: unused ⇒ 'missing') */
export async function membershipProgramUsed(tenantId: string): Promise<boolean> {
  const rows = await withTenant(tenantId, (tx) =>
    tx.select({ id: membership.id }).from(membership).where(eq(membership.tenantId, tenantId)).limit(1));
  return rows.length > 0;
}
