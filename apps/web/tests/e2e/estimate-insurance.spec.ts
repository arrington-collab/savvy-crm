import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  customer,
  property,
  lead,
  measurement,
  tierProduct,
  estimate,
  eq,
  ensurePriceBook,
  ensureTierProducts,
  ensureEstimateLink,
  setEstimateStatus,
  createEstimateFromMeasurement,
  attachOrCreateLeadClaim,
  findOrCreatePartnerTx,
  withTenant,
} from "@savvy/db";

const tenantId = process.env.TEST_TENANT_ID ?? JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")).id;

let code: string;

test.beforeAll(async () => {
  await ensurePriceBook(tenantId);
  await ensureTierProducts(tenantId);
  await withTenant(tenantId, (tx) =>
    tx.update(tierProduct).set({ unitPriceCents: 21000, unitCostCents: 12500 }).where(eq(tierProduct.tenantId, tenantId)),
  );
  const stamp = `${Date.now().toString(36)}i`;
  const ids = await withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name: `Claim-${stamp}`, phone: "+15555559966" }).returning();
    const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: `${stamp} Hail Ct`, city: "Denver", state: "CO" }).returning();
    const pr = await findOrCreatePartnerTx(tx, tenantId, { name: `Agency-${stamp}`, class: "insurance_agent" });
    const [l] = await tx.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, source: "insurance_agent", status: "qualified", partnerId: pr.id }).returning();
    const [m] = await tx.insert(measurement).values({
      tenantId, propertyId: p!.id, provider: "roofr",
      areas: { squares: 28, predominantPitch: "6/12", eaveLf: 130, rakeLf: 60, ridgeLf: 42 },
    }).returning();
    return { leadId: l!.id, measurementId: m!.id, propertyId: p!.id };
  });
  const est = await createEstimateFromMeasurement({ tenantId, leadId: ids.leadId, measurementId: ids.measurementId });
  await withTenant(tenantId, (tx) =>
    tx.update(estimate).set({ upsellSuggestions: [{ name: "Impact-resistant shingles", reason: "hail zone", unitPriceCents: 30000, quantity: 10 }] }).where(eq(estimate.id, est!.id)),
  );
  await attachOrCreateLeadClaim({
    tenantId,
    leadId: ids.leadId,
    propertyId: ids.propertyId,
    carrierName: "State Farm",
    claimNumber: "SF-E2E-1",
    acvCents: 2_000_000,
    rcvCents: 2_400_000,
    deductibleCents: 150_000,
    lineItems: [],
    parseConfidence: 1,
  });
  await setEstimateStatus({ tenantId, estimateId: est!.id, status: "sent" });
  ({ code } = await ensureEstimateLink({ tenantId, estimateId: est!.id }));
});

test("insurance variant: claim panel + SB38 deductible framing + add-ons, NO tiers, accept armed without a pick", async ({ page }) => {
  await page.goto(`/estimate/${code}`);
  await expect(page.getByTestId("estimate-page")).toBeVisible({ timeout: 20_000 });

  // claim-aligned scope, not tier cards
  await expect(page.getByTestId("insurance-scope")).toBeVisible();
  await expect(page.getByTestId("claim-panel")).toContainText("State Farm");
  await expect(page.getByTestId("claim-panel")).toContainText("$24,000");
  await expect(page.getByTestId("deductible-line")).toContainText("Colorado law");
  await expect(page.getByTestId("deductible-line")).toContainText("$1,500");
  await expect(page.locator('[data-testid="tier-card-better"]')).toHaveCount(0);

  // upgrades as out-of-pocket add-ons
  await expect(page.getByTestId("insurance-addons")).toContainText("Impact-resistant shingles");
  await expect(page.getByTestId("insurance-addons")).toContainText("+$3,000");

  // the accept CTA is armed with no tier/color pick required
  await expect(page.getByTestId("accept-cta")).toBeEnabled();

  // same trust strip + validity as retail
  await expect(page.getByTestId("estimate-trust")).toBeVisible();
  await expect(page.getByTestId("estimate-validity")).toBeVisible();
});

test("close-rate report renders with honest insufficient-data states", async ({ page }) => {
  await page.goto("/reports/close-rate");
  await expect(page.getByTestId("close-rate-versions")).toBeVisible({ timeout: 20_000 });
  // the shared tenant has estimates from this suite but nowhere near 20 per version
  await expect(page.getByTestId("close-rate-versions")).toContainText("insufficient data");
});
