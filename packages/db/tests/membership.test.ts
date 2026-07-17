import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { adminDb } from "../src/admin-client";
import { membership } from "../src/schema/membership";
import { tenant } from "../src/schema/tenancy";
import { makeTenant, makeLeadWithCustomer } from "./helpers";
import {
  startMembershipCheckout, activateMembershipFromCheckout, cancelMembership,
  maintenanceMrrCents, activeMemberCustomerIds,
} from "../src/lifecycle/membership";
import { gatherValuationInputs } from "../src/lifecycle/valuation";

const NOW = new Date("2026-07-15T12:00:00-07:00");

async function connectStripe(tenantId: string) {
  await adminDb.update(tenant).set({ stripeAccountId: "acct_test_p20" }).where(eq(tenant.id, tenantId));
}

const fakeStripe = {
  createSubscriptionCheckout: async (o: Record<string, unknown>) => ({
    id: `cs_sub_${Math.random().toString(36).slice(2, 8)}`,
    url: "https://checkout.stripe.test/sub",
    subscriptionId: null,
    _o: o,
  }),
  cancelSubscription: async () => ({ canceled: true }),
};

describe("membership — the annual tune-up subscription (Phase 20 #305)", () => {
  it("checkout creates a pending membership; the webhook activates it with the Stripe subscription id", async () => {
    const { tenantId } = await makeTenant();
    await connectStripe(tenantId);
    const { customerId } = await makeLeadWithCustomer(tenantId);

    const r = await startMembershipCheckout(tenantId, { customerId, stripe: fakeStripe });
    expect("url" in r && r.url).toContain("checkout.stripe.test");

    const [pending] = await adminDb.select().from(membership).where(eq(membership.tenantId, tenantId));
    expect(pending!.status).toBe("pending");

    await activateMembershipFromCheckout(tenantId, {
      checkoutSessionId: pending!.checkoutSessionId!, stripeSubscriptionId: "sub_live_1", now: NOW,
    });
    const [active] = await adminDb.select().from(membership).where(eq(membership.id, pending!.id));
    expect(active!.status).toBe("active");
    expect(active!.stripeSubscriptionId).toBe("sub_live_1");
    expect(active!.startedAt).not.toBeNull();
  });

  it("SPEC FAIL-SOFT: without a connected Stripe account the membership parks as draft — never a fake active", async () => {
    const { tenantId } = await makeTenant(); // no stripeAccountId
    const { customerId } = await makeLeadWithCustomer(tenantId);

    const r = await startMembershipCheckout(tenantId, { customerId, stripe: fakeStripe });
    expect("error" in r ? r.error : "").toContain("stripe");

    const rows = await adminDb.select().from(membership).where(eq(membership.tenantId, tenantId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("draft");
  });

  it("cancel requires a tagged reason and releases the Stripe subscription", async () => {
    const { tenantId } = await makeTenant();
    await connectStripe(tenantId);
    const { customerId } = await makeLeadWithCustomer(tenantId);
    const r = await startMembershipCheckout(tenantId, { customerId, stripe: fakeStripe });
    const [row] = await adminDb.select().from(membership).where(eq(membership.tenantId, tenantId));
    await activateMembershipFromCheckout(tenantId, { checkoutSessionId: row!.checkoutSessionId!, stripeSubscriptionId: "sub_c1", now: NOW });

    const out = await cancelMembership(tenantId, { membershipId: row!.id, reason: "moved", stripe: fakeStripe, now: NOW });
    expect(out).toEqual({ ok: true });
    const [canceled] = await adminDb.select().from(membership).where(eq(membership.id, row!.id));
    expect(canceled!.status).toBe("canceled");
    expect(canceled!.cancellationReason).toBe("moved");
    expect(canceled!.canceledAt).not.toBeNull();
    void r;
  });
});

describe("MRR — the valuation engine's missing input becomes real", () => {
  it("sums active memberships as monthly-equivalent cents (annual/12)", async () => {
    const { tenantId } = await makeTenant();
    await connectStripe(tenantId);
    for (let i = 0; i < 3; i++) {
      const { customerId } = await makeLeadWithCustomer(tenantId);
      await startMembershipCheckout(tenantId, { customerId, stripe: fakeStripe });
    }
    const rows = await adminDb.select().from(membership).where(eq(membership.tenantId, tenantId));
    for (const row of rows.slice(0, 2)) {
      await activateMembershipFromCheckout(tenantId, { checkoutSessionId: row.checkoutSessionId!, stripeSubscriptionId: `sub_${row.id.slice(0, 6)}`, now: NOW });
    }
    // 2 active × $348/yr default = 2 × 2900 = 5800 monthly-equivalent; the pending one doesn't count.
    expect(await maintenanceMrrCents(tenantId)).toBe(5800);
  });

  it("HONESTY: tenants that never touched the product stay 'missing'; a participating tenant reads 'real'", async () => {
    const { tenantId: untouched } = await makeTenant();
    const inputsA = await gatherValuationInputs(untouched, NOW);
    expect(inputsA.maintenanceMrrCents.quality).toBe("missing");

    const { tenantId } = await makeTenant();
    await connectStripe(tenantId);
    const { customerId } = await makeLeadWithCustomer(tenantId);
    await startMembershipCheckout(tenantId, { customerId, stripe: fakeStripe });
    const [row] = await adminDb.select().from(membership).where(eq(membership.tenantId, tenantId));
    await activateMembershipFromCheckout(tenantId, { checkoutSessionId: row!.checkoutSessionId!, stripeSubscriptionId: "sub_v", now: NOW });

    const inputsB = await gatherValuationInputs(tenantId, NOW);
    expect(inputsB.maintenanceMrrCents).toEqual({ value: 2900, quality: "real" });
  });
});

describe("activeMemberCustomerIds — the top Strike List tier (Phase 20 S4 #309)", () => {
  it("returns only customers with an ACTIVE membership (draft/pending/canceled excluded)", async () => {
    const { tenantId } = await makeTenant();
    await connectStripe(tenantId);
    const active = await makeLeadWithCustomer(tenantId);
    const pending = await makeLeadWithCustomer(tenantId);
    const canceled = await makeLeadWithCustomer(tenantId);

    // active
    await startMembershipCheckout(tenantId, { customerId: active.customerId, stripe: fakeStripe });
    const [aRow] = await adminDb.select().from(membership)
      .where(and(eq(membership.tenantId, tenantId), eq(membership.customerId, active.customerId)));
    await activateMembershipFromCheckout(tenantId, { checkoutSessionId: aRow!.checkoutSessionId!, stripeSubscriptionId: "sub_a", now: NOW });

    // pending (never activated)
    await startMembershipCheckout(tenantId, { customerId: pending.customerId, stripe: fakeStripe });

    // canceled
    await startMembershipCheckout(tenantId, { customerId: canceled.customerId, stripe: fakeStripe });
    const [cRow] = await adminDb.select().from(membership)
      .where(and(eq(membership.tenantId, tenantId), eq(membership.customerId, canceled.customerId)));
    await activateMembershipFromCheckout(tenantId, { checkoutSessionId: cRow!.checkoutSessionId!, stripeSubscriptionId: "sub_c", now: NOW });
    await cancelMembership(tenantId, { membershipId: cRow!.id, reason: "moved", stripe: fakeStripe, now: NOW });

    const ids = await activeMemberCustomerIds(tenantId);
    expect(ids.has(active.customerId)).toBe(true);
    expect(ids.has(pending.customerId)).toBe(false);
    expect(ids.has(canceled.customerId)).toBe(false);
    expect(ids.size).toBe(1);
  });
});
