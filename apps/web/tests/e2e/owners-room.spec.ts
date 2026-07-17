import { test, expect } from "@playwright/test";

// Owner's Room S2. The shared e2e tenant's data varies with suite order, so
// these assertions hold in EITHER honest state: a real range, or a named
// refusal — never a silent number, and always the not-an-appraisal caption.
test("owner's room: renders an honest range or an honest refusal, with methodology", async ({ page }) => {
  await page.goto("/money/owners-room");
  await expect(page.getByTestId("owners-room-page")).toBeVisible();

  const headline = page.getByTestId("valuation-headline");
  const insufficient = page.getByTestId("valuation-insufficient");
  await expect(headline.or(insufficient)).toBeVisible();

  if (await headline.isVisible()) {
    // A RANGE, never a point — the headline carries two dollar figures.
    await expect(headline).toContainText("–");
    await expect(page.getByTestId("quality-badge")).toBeVisible();
    await expect(page.getByTestId("value-bridge")).toBeVisible();
  } else {
    // Refusal names its reasons.
    await expect(insufficient.locator("li").first()).toBeVisible();
  }

  // The standing caption and methodology are non-negotiable in both states.
  await expect(page.getByTestId("owners-room-page")).toContainText("not an appraisal");
  await expect(page.getByTestId("valuation-methodology")).toContainText("version");
});

test("owner's room: linked from the Money page", async ({ page }) => {
  await page.goto("/money");
  await page.getByRole("link", { name: "Owner's Room" }).click();
  await page.waitForURL(/\/money\/owners-room/);
  await expect(page.getByTestId("owners-room-page")).toBeVisible();
});
