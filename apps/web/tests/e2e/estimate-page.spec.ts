import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  adminDb,
  customer,
  property,
  lead,
  measurement,
  tierProduct,
  eq,
  ensurePriceBook,
  ensureTierProducts,
  ensureEstimateLink,
  setEstimateStatus,
  createEstimateFromMeasurement,
  withTenant,
} from "@savvy/db";

const tenantId = process.env.TEST_TENANT_ID ?? JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")).id;

let code: string;
let estimateId: string;

test.beforeAll(async () => {
  await ensurePriceBook(tenantId);
  await ensureTierProducts(tenantId);
  // price the tiers so the page has real totals
  await withTenant(tenantId, (tx) =>
    tx.update(tierProduct).set({ unitPriceCents: 21000, unitCostCents: 12500 }).where(eq(tierProduct.tenantId, tenantId)),
  );

  const stamp = Date.now().toString(36);
  const { custId, propId } = await withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name: `EstPage-${stamp}`, phone: "+15555559911" }).returning();
    const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: "77 Page Ln", city: "Phoenix", state: "AZ" }).returning();
    return { custId: c!.id, propId: p!.id };
  });
  const leadId = await withTenant(tenantId, async (tx) => {
    const [l] = await tx.insert(lead).values({ tenantId, customerId: custId, propertyId: propId, source: "referral", status: "qualified" }).returning();
    return l!.id;
  });
  const measurementId = await withTenant(tenantId, async (tx) => {
    const [m] = await tx.insert(measurement).values({
      tenantId,
      propertyId: propId,
      provider: "roofr",
      areas: { squares: 22, predominantPitch: "6/12", eaveLf: 110, rakeLf: 55, ridgeLf: 35, valleyLf: 12 },
    }).returning();
    return m!.id;
  });

  const est = await createEstimateFromMeasurement({ tenantId, leadId, measurementId });
  estimateId = est!.id;
  await setEstimateStatus({ tenantId, estimateId, status: "sent" });
  ({ code } = await ensureEstimateLink({ tenantId, estimateId }));
});

test("homeowner estimate page renders tiers, colors persist, trust + validity show", async ({ page }) => {
  await page.goto(`/estimate/${code}`);
  await expect(page.getByTestId("estimate-page")).toBeVisible({ timeout: 20_000 });

  // Three tier cards, recommended badge on Better, priced totals
  await expect(page.getByTestId("tier-card-good")).toContainText("IKO Cambridge");
  await expect(page.getByTestId("tier-card-better")).toContainText("Recommended");
  await expect(page.getByTestId("tier-card-best")).toContainText("TAMKO Titan XT");
  await expect(page.getByTestId("tier-total-better")).not.toContainText("Ask us");

  // Pick Better → its palette appears → pick a color (persists via the public API)
  await page.getByTestId("tier-card-better").click();
  await expect(page.getByTestId("color-selector")).toBeVisible();
  await page.getByTestId("color-granite-black").click();
  await expect(page.getByTestId("color-granite-black")).toContainText("✓");

  // What's included, warranty panel, trust strip, validity line
  await expect(page.getByTestId("estimate-included")).toContainText("magnetic nail sweep");
  await expect(page.getByTestId("warranty-panel")).toContainText("IKO");
  await expect(page.getByTestId("estimate-trust")).toContainText("Licensed & insured");
  await expect(page.getByTestId("estimate-validity")).toContainText("Price valid through");

  // Reload: the stored selection comes back from the estimate row (no clicks —
  // initialTier/initialColor hydrate straight from the server)
  await page.reload();
  await expect(page.getByTestId("color-selector")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("color-granite-black")).toContainText("✓");
});

test("a bogus code shows the invalid page, never someone's estimate", async ({ page }) => {
  await page.goto("/estimate/nope99");
  await expect(page.getByTestId("estimate-invalid")).toBeVisible({ timeout: 20_000 });
});
