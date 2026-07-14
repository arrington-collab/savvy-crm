import { test, expect } from "@playwright/test";

// Estimate Experience slice 1: the Library price-book page grows tier products,
// the needs-costs card, the paste-a-sheet flow, and version history.
import { withTenant, tierProduct, ensureTierProducts as seedTiers, eq } from "@savvy/db";
import { readFileSync } from "node:fs";

const tenantId = process.env.TEST_TENANT_ID ?? JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")).id;

test.beforeAll(async () => {
  // Own the shared-tenant state this spec asserts: other specs (estimate-page)
  // PRICE the tier products; the needs-costs card requires them unpriced.
  await seedTiers(tenantId);
  await withTenant(tenantId, (tx) =>
    tx.update(tierProduct).set({ unitPriceCents: null, unitCostCents: null }).where(eq(tierProduct.tenantId, tenantId)),
  );
});

test("price book page renders Good/Better/Best, the needs-costs card, and the sheet-parse flow", async ({ page }) => {
  await page.goto("/settings/price-book");
  await expect(page.getByTestId("tier-products")).toBeVisible({ timeout: 20_000 });

  // The three owner-decided products, seeded unpriced
  await expect(page.getByTestId("tier-product-good")).toContainText("IKO Cambridge");
  await expect(page.getByTestId("tier-product-better")).toContainText("IKO Dynasty");
  await expect(page.getByTestId("tier-product-better")).toContainText("Recommended");
  await expect(page.getByTestId("tier-product-best")).toContainText("TAMKO Titan XT");

  // Unpriced slots surface the "needs costs" card — we never invent numbers
  await expect(page.getByTestId("needs-costs-card")).toBeVisible();
  await expect(page.getByTestId("needs-costs-card")).toContainText("never invent");

  // The fast-price-update entry point exists
  await expect(page.getByTestId("sheet-parse")).toBeVisible();
});
