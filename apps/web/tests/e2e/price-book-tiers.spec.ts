import { test, expect } from "@playwright/test";

// Estimate Experience slice 1: the Library price-book page grows tier products,
// the needs-costs card, the paste-a-sheet flow, and version history.
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
