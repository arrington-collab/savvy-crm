import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  adminDb,
  customer,
  property,
  lead,
  job,
  measurement,
  tierProduct,
  tenant,
  estimate,
  eq,
  and,
  ensurePriceBook,
  ensureTierProducts,
  ensureEstimateLink,
  setEstimateStatus,
  createEstimateFromMeasurement,
  withTenant,
} from "@savvy/db";

const tenantId = process.env.TEST_TENANT_ID ?? JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")).id;

async function seedSentEstimate(stamp: string): Promise<{ code: string; estimateId: string; leadId: string }> {
  const { custId, propId } = await withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name: `Accept-${stamp}`, phone: "+15555559922" }).returning();
    const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: `${stamp} Accept Way`, city: "Phoenix", state: "AZ" }).returning();
    return { custId: c!.id, propId: p!.id };
  });
  const leadId = await withTenant(tenantId, async (tx) => {
    const [l] = await tx.insert(lead).values({ tenantId, customerId: custId, propertyId: propId, source: "referral", status: "qualified" }).returning();
    return l!.id;
  });
  const measurementId = await withTenant(tenantId, async (tx) => {
    const [m] = await tx.insert(measurement).values({
      tenantId, propertyId: propId, provider: "roofr",
      areas: { squares: 24, predominantPitch: "6/12", eaveLf: 120, rakeLf: 60, ridgeLf: 40 },
    }).returning();
    return m!.id;
  });
  const est = await createEstimateFromMeasurement({ tenantId, leadId, measurementId });
  await setEstimateStatus({ tenantId, estimateId: est!.id, status: "sent" });
  const { code } = await ensureEstimateLink({ tenantId, estimateId: est!.id });
  return { code, estimateId: est!.id, leadId };
}

test.beforeAll(async () => {
  await ensurePriceBook(tenantId);
  await ensureTierProducts(tenantId);
  await withTenant(tenantId, (tx) =>
    tx.update(tierProduct).set({ unitPriceCents: 21000, unitCostCents: 12500 }).where(eq(tierProduct.tenantId, tenantId)),
  );
  // a connected (sentinel) Stripe account makes the 50% deposit REQUIRED
  await adminDb.update(tenant).set({ stripeAccountId: "acct_demo" }).where(eq(tenant.id, tenantId));
});

test("accept flow: sign → deposit → job created → install week → confirmation (webhooks idempotent)", async ({ page, request }) => {
  const stamp = Date.now().toString(36);
  const { code, estimateId, leadId } = await seedSentEstimate(stamp);

  await page.goto(`/estimate/${code}`);
  await expect(page.getByTestId("estimate-page")).toBeVisible({ timeout: 20_000 });

  // Pick Better + a color, then accept
  await page.getByTestId("tier-card-better").click();
  await page.getByTestId("color-granite-black").click();
  await expect(page.getByTestId("color-granite-black")).toContainText("✓");
  await page.getByTestId("accept-cta").click();

  // Step 1: signing link minted (fake DocuSeal)
  await expect(page.getByTestId("accept-steps")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("sign-link")).toBeVisible();

  // DocuSeal completion arrives via webhook → signed-but-unpaid state (RED PATH:
  // signing alone must NOT create the job)
  const [est] = await withTenant(tenantId, (tx) => tx.select().from(estimate).where(eq(estimate.id, estimateId)));
  const whSign = await request.post("/api/docuseal/webhook", {
    data: { event_type: "form.completed", data: { submission_id: est!.docusealSubmissionId } },
  });
  expect(whSign.ok()).toBeTruthy();
  await expect(page.getByTestId("step-sign")).toHaveAttribute("data-done", "true", { timeout: 20_000 });
  await expect(page.getByTestId("signed-unpaid")).toBeVisible();
  const jobsAfterSign = await withTenant(tenantId, (tx) => tx.select().from(job).where(eq(job.leadId, leadId)));
  expect(jobsAfterSign).toHaveLength(0);

  // Deposit settles via the Stripe webhook (fake gateway parses raw JSON) →
  // acceptance fires → the EXISTING chain creates the job
  const paySession = {
    type: "checkout.session.completed",
    data: {
      object: {
        id: `cs_e2e_${stamp}`,
        payment_intent: `pi_e2e_${stamp}`,
        amount_total: est!.depositAmountCents,
        payment_status: "paid",
        metadata: { tenantId, invoiceId: `estimate-deposit:${estimateId}`, kind: "estimate_deposit", estimateId },
      },
    },
  };
  const whPay = await request.post("/api/stripe/webhook", { data: paySession });
  expect(whPay.ok()).toBeTruthy();

  // Confirmation appears once Inngest lands the acceptance (job + lead won)
  await expect(page.getByTestId("accept-confirmation")).toBeVisible({ timeout: 45_000 });

  // Idempotency: replaying BOTH webhooks must not create a second job
  await request.post("/api/docuseal/webhook", {
    data: { event_type: "form.completed", data: { submission_id: est!.docusealSubmissionId } },
  });
  await request.post("/api/stripe/webhook", { data: paySession });
  const jobs = await withTenant(tenantId, (tx) => tx.select().from(job).where(eq(job.leadId, leadId)));
  expect(jobs).toHaveLength(1);

  // Install week: pick the first offered Monday → soft hold + confirmation copy
  await expect(page.getByTestId("week-picker")).toBeVisible();
  await page.getByTestId("week-picker").locator("button").first().click();
  await expect(page.getByTestId("week-confirmed")).toBeVisible({ timeout: 15_000 });
  const [j] = await withTenant(tenantId, (tx) => tx.select().from(job).where(eq(job.leadId, leadId)));
  expect(j!.requestedInstallWeek).not.toBeNull();
  // the soft hold is NOT an appointment — production stage evidence untouched
  expect(j!.stage).toBe("approved");

  // Status link for the homeowner
  await expect(page.getByTestId("status-link")).toBeVisible();
});

test("RED PATH: an expired estimate offers renewal instead of accepting at stale prices", async ({ page }) => {
  const stamp = `${Date.now().toString(36)}x`;
  const { code, estimateId } = await seedSentEstimate(stamp);
  await withTenant(tenantId, (tx) =>
    tx.update(estimate).set({ sentAt: new Date(Date.now() - 40 * 86_400_000) }).where(eq(estimate.id, estimateId)),
  );

  await page.goto(`/estimate/${code}`);
  await expect(page.getByTestId("estimate-page")).toBeVisible({ timeout: 20_000 });
  // the page itself flags expiry and the accept CTA is replaced by the renewal prompt
  await expect(page.getByTestId("estimate-expired")).toBeVisible();
  await expect(page.getByTestId("renewal-prompt")).toBeVisible();
});
