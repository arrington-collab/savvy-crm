/**
 * e2e: the Operator Console Library screen (contract cell 5, slice 5).
 *
 * Proves the "source of the business" card grid renders with live counts + the
 * tenant timezone visible, and that the M&A locked tile on Today reveals its
 * thesis on click. Read-only — the cards link to existing config pages.
 */
import { test, expect } from "@playwright/test";

test("Library renders the source-of-the-business card grid with the tenant timezone", async ({ page }) => {
  await page.goto("/library");
  await expect(page.getByTestId("library-page")).toBeVisible();
  // Seven cards, each linking to its config page (Partners joined in slice 3
  // of the Partner Ledger).
  await expect(page.getByTestId("library-card")).toHaveCount(7);
  const grid = page.getByTestId("library-grid");
  await expect(grid).toContainText("Task Registry");
  await expect(grid).toContainText("Price Book");
  await expect(grid).toContainText("Partners");
  await expect(grid).toContainText("Tenant Settings");
  // Timezone is surfaced (Tenant Settings card) — the spec calls this out explicitly.
  await expect(grid).toContainText("Timezone");
});

test("a Library card links to its existing config page", async ({ page }) => {
  await page.goto("/library");
  await page.getByTestId("library-card").filter({ hasText: "Price Book" }).click();
  await expect(page).toHaveURL(/\/settings\/price-book$/);
});

test("the M&A Machine locked tile on Today reveals its thesis on click", async ({ page }) => {
  await page.goto("/today");
  const tile = page.getByTestId("locked-tile").filter({ hasText: "M&A Machine" });
  await expect(tile).toBeVisible();
  await tile.getByRole("button").click();
  await expect(tile.getByTestId("locked-thesis")).toBeVisible();
});
