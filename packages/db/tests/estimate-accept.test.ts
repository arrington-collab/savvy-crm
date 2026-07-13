import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { createEstimateFromMeasurement, setEstimateStatus } from "../src/lifecycle/estimate.js";
import { ensurePriceBook, ensureTierProducts } from "../src/lifecycle/price-book.js";
import {
  beginEstimateAcceptance,
  recordEstimateDeposit,
  estimateAcceptanceState,
} from "../src/lifecycle/estimate-accept.js";
import { withTenant } from "../src/tenant.js";
import { adminDb } from "../src/admin-client.js";
import { tenant } from "../src/schema/tenancy.js";
import { estimate } from "../src/schema/finance.js";
import { measurement } from "../src/schema/ops.js";
import { tierProduct } from "../src/schema/pricing.js";
import { makeTenant, makeJobWithProperty } from "./helpers.js";

let tenantId: string;
let leadEstimateId: string;

const fakeDocuseal = {
  createSubmission: async () => ({ submissionId: `ds_${Math.random().toString(36).slice(2)}`, signUrl: "https://docuseal.test/s/abc" }),
};
const fakeStripe = {
  createCheckoutSession: async () => ({ id: `cs_${Math.random().toString(36).slice(2)}`, url: "https://checkout.stripe.test/x", paymentIntentId: "pi_x" }),
};

async function seedEstimate(): Promise<string> {
  const { propertyId, jobId } = await makeJobWithProperty(tenantId);
  const measurementId = await withTenant(tenantId, async (tx) => {
    const [m] = await tx.insert(measurement).values({
      tenantId, propertyId, provider: "roofr",
      areas: { squares: 20, predominantPitch: "6/12", eaveLf: 100, rakeLf: 50 },
    }).returning();
    return m!.id;
  });
  const est = await createEstimateFromMeasurement({ tenantId, jobId, measurementId });
  await setEstimateStatus({ tenantId, estimateId: est!.id, status: "sent" });
  return est!.id;
}

beforeAll(async () => {
  const t = await makeTenant();
  tenantId = t.tenantId;
  await ensurePriceBook(tenantId);
  await ensureTierProducts(tenantId);
  await withTenant(tenantId, (tx) =>
    tx.update(tierProduct).set({ unitPriceCents: 20000, unitCostCents: 12000 }),
  );
  // connect a (fake) Stripe account so deposits are required
  await adminDb.update(tenant).set({ stripeAccountId: "acct_demo" }).where(eq(tenant.id, tenantId));
  leadEstimateId = await seedEstimate();
});

describe("beginEstimateAcceptance", () => {
  it("persists the pick, mints sign + deposit artifacts, and is idempotent", async () => {
    const first = await beginEstimateAcceptance(
      { tenantId, estimateId: leadEstimateId, tier: "better", color: "Granite Black", successUrl: "https://x/ok", cancelUrl: "https://x/no" },
      { docuseal: fakeDocuseal, stripe: fakeStripe },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.signingUrl).toContain("docuseal.test");
    expect(first.deposit.required).toBe(true);
    // 50% of the BETTER tier subtotal, not the estimate's single-price total
    const [row] = await withTenant(tenantId, (tx) => tx.select().from(estimate).where(eq(estimate.id, leadEstimateId)));
    expect(first.deposit.amountCents).toBe(row!.depositAmountCents);
    expect(row!.selectedTier).toBe("better");
    expect(row!.signingUrl).toContain("docuseal.test");
    expect(row!.depositCheckoutSessionId).not.toBeNull();

    // second call returns the SAME artifacts — no duplicate submissions/sessions
    const again = await beginEstimateAcceptance(
      { tenantId, estimateId: leadEstimateId, tier: "better", color: "Granite Black", successUrl: "https://x/ok", cancelUrl: "https://x/no" },
      { docuseal: fakeDocuseal, stripe: fakeStripe },
    );
    expect(again.ok && again.signingUrl).toBe(first.signingUrl);
    expect(again.ok && again.deposit.checkoutUrl).toBe(first.deposit.checkoutUrl);
  });

  it("RED PATH: an expired estimate refuses acceptance with a renewal state", async () => {
    const expiredId = await seedEstimate();
    await withTenant(tenantId, (tx) =>
      tx.update(estimate).set({ sentAt: new Date(Date.now() - 40 * 86_400_000) }).where(eq(estimate.id, expiredId)),
    );
    const res = await beginEstimateAcceptance(
      { tenantId, estimateId: expiredId, tier: "good", color: "Dual Black", successUrl: "https://x/ok", cancelUrl: "https://x/no" },
      { docuseal: fakeDocuseal, stripe: fakeStripe },
    );
    expect(res).toEqual({ ok: false, error: "expired" });
  });
});

describe("deposit + acceptance gate", () => {
  it("signed-but-unpaid does NOT reach ready; deposit completes it; double deposit is idempotent", async () => {
    // sign
    await withTenant(tenantId, (tx) =>
      tx.update(estimate).set({ signedAt: new Date() }).where(eq(estimate.id, leadEstimateId)),
    );
    let state = await estimateAcceptanceState(tenantId, leadEstimateId);
    expect(state).toMatchObject({ signed: true, depositPaid: false, ready: false });

    const dep = await recordEstimateDeposit({ tenantId, estimateId: leadEstimateId, stripePaymentId: "pi_test_1" });
    expect(dep.nowReady).toBe(true);
    const again = await recordEstimateDeposit({ tenantId, estimateId: leadEstimateId, stripePaymentId: "pi_test_1" });
    expect(again.alreadyRecorded).toBe(true);

    state = await estimateAcceptanceState(tenantId, leadEstimateId);
    expect(state).toMatchObject({ signed: true, depositPaid: true, ready: true });
  });
});

describe("installWeekOptions", () => {
  it("offers the next N Mondays, none earlier than the mobilization lead time", async () => {
    const { installWeekOptions } = await import("../src/lifecycle/estimate-accept.js");
    // Wed 2026-07-15 + 7 lead days = Wed 2026-07-22 → first Monday on/after = 2026-07-27
    const opts = installWeekOptions(new Date("2026-07-15T18:00:00Z"));
    expect(opts).toHaveLength(6);
    expect(opts[0]!.toISOString().slice(0, 10)).toBe("2026-07-27");
    for (const o of opts) expect(o.getUTCDay()).toBe(1); // all Mondays
    // consecutive weeks
    expect(opts[1]!.getTime() - opts[0]!.getTime()).toBe(7 * 86_400_000);
  });

  it("from a Monday, the earliest offer is the NEXT Monday past the lead window", async () => {
    const { installWeekOptions } = await import("../src/lifecycle/estimate-accept.js");
    // Mon 2026-07-13 + 7d = Mon 2026-07-20 → that Monday itself qualifies
    const opts = installWeekOptions(new Date("2026-07-13T08:00:00Z"));
    expect(opts[0]!.toISOString().slice(0, 10)).toBe("2026-07-20");
  });
});
