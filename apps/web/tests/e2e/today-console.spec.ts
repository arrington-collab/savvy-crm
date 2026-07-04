/**
 * e2e: the Operator Console (contract cell 5, slice 1 — Today).
 *
 * Covers the IA transformation: the legacy /exceptions worklist 301-redirects
 * into the Today decision queue, Today renders the console shell on real data,
 * the 13-item nav collapses to 5 reachable sections, and uninstrumented metrics
 * degrade to "—" rather than fabricating numbers.
 */
import { test, expect } from "@playwright/test";

test("/exceptions redirects into the Today console", async ({ page }) => {
  await page.goto("/exceptions");
  await expect(page).toHaveURL(/\/today$/);
  await expect(page.getByTestId("today-page")).toBeVisible();
});

test("Today renders the console shell — portfolio, queue, digest, money, coverage", async ({ page }) => {
  await page.goto("/today");
  await expect(page.getByTestId("today-page")).toBeVisible();
  await expect(page.getByTestId("portfolio-strip")).toBeVisible();
  await expect(page.getByTestId("decision-headline")).toBeVisible();
  await expect(page.getByTestId("decision-queue")).toBeVisible();
  await expect(page.getByTestId("digest-panel")).toBeVisible();
  await expect(page.getByTestId("money-strip")).toBeVisible();
  // Coverage Map (reused Empire Coverage component) renders on Today.
  await expect(page.getByText("Empire Coverage")).toBeVisible();
});

test("the money strip degrades uninstrumented metrics to — instead of fabricating", async ({ page }) => {
  await page.goto("/today");
  const money = page.getByTestId("money-strip");
  // GM actuals land in cell 14 → the KPI must render an em dash, never a made-up %.
  await expect(money).toContainText("GM · MTD");
  await expect(money).toContainText("—");
  await expect(money).toContainText("Founder-min / job");
});

test("the nav collapses to 5 sections, each reachable", async ({ page }) => {
  await page.goto("/today");
  const sidebar = page.getByTestId("sidebar");
  for (const label of ["today", "pipeline", "money", "agents", "library"]) {
    await expect(sidebar.getByTestId(`nav-${label}`)).toBeVisible();
  }

  await sidebar.getByTestId("nav-pipeline").click();
  await expect(page).toHaveURL(/\/pipeline$/);
  await expect(page.getByTestId("pipeline-page")).toBeVisible(); // real board (slice 2)

  await sidebar.getByTestId("nav-money").click();
  await expect(page).toHaveURL(/\/money$/);
  await expect(page.getByTestId("money-page")).toBeVisible(); // real money screen (slice 3)

  await sidebar.getByTestId("nav-agents").click();
  await expect(page).toHaveURL(/\/agents$/);
  await expect(page.getByTestId("agents-page")).toBeVisible(); // real roster (slice 4)

  await sidebar.getByTestId("nav-library").click();
  await expect(page).toHaveURL(/\/library$/);
  await expect(page.getByTestId("library-page")).toBeVisible(); // real library grid (slice 5)
});
