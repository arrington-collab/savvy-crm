import { test, expect } from "@playwright/test";

// Regression guard: the price-book settings page once 500'd because its query
// module mixed `import "server-only"` with an inline "use server" action that the
// client component imported (a bundler-boundary error that typecheck doesn't
// catch). No e2e loaded the page, so it shipped broken. This asserts it renders.
test("price book settings page renders the seeded catalog", async ({ page }) => {
  await page.goto("/settings/price-book");
  await expect(page.getByRole("heading", { name: "Price Book" })).toBeVisible();
  // ensurePriceBook lazy-seeds the default catalog on first open.
  await expect(page.getByTestId("price-book-row").first()).toBeVisible();
  await expect(page.getByText("Field shingles").first()).toBeVisible();
});
