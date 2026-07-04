/**
 * e2e: the per-tenant supplier-invoice forwarding address surfaces in Library (cell 13a).
 */
import { test, expect } from "@playwright/test";

test("Library surfaces the tenant's supplier-invoice forwarding address", async ({ page }) => {
  await page.goto("/library");
  await expect(page.getByTestId("supplier-inbox-address")).toContainText(/^inv-[A-Za-z0-9]+@inbox\.getsavvy\.com$/);
});
