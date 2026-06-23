import { test, expect } from "@playwright/test";

test("create a lead with phone auto-format + optional roof/year", async ({ page }) => {
  await page.goto("/leads/new");
  await page.getByLabel("Customer name").fill("E2E Tester");
  const phone = page.getByLabel("Phone");
  await phone.fill("4805551234");
  await expect(phone).toHaveValue("(480) 555-1234"); // as-you-type formatting
  await page.getByTestId("address-autocomplete").fill("100 Test St, Mesa AZ 85201");
  await page.getByTestId("roof-type").selectOption("tile");
  await page.getByTestId("year-built").fill("2004");
  await page.getByTestId("new-lead-submit").click();
  await expect(page).toHaveURL(/\/leads\/[0-9a-f-]+$/);
});

test("can add a new lead source inline and select it", async ({ page }) => {
  await page.goto("/leads/new");
  await page.getByTestId("lead-source-add-toggle").click();
  await page.getByTestId("lead-source-new").fill("Home Show");
  await page.getByTestId("lead-source-save").click();
  await expect(page.getByTestId("lead-source")).toHaveValue("Home Show");
});
