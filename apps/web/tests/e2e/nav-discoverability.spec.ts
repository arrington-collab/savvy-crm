import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { withTenant, customer, property, job, lead } from "@savvy/db";

const { id: tenantId } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string };

async function seedJob() {
  return withTenant(tenantId, async (tx) => {
    const [c] = await tx
      .insert(customer)
      .values({ tenantId, name: "Nav Test Customer", phone: "+15555550001" })
      .returning();
    const [p] = await tx
      .insert(property)
      .values({ tenantId, customerId: c!.id, address: "1 Nav Test St" })
      .returning();
    const [j] = await tx
      .insert(job)
      .values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "lead" })
      .returning();
    return j!.id;
  });
}

async function seedLead() {
  return withTenant(tenantId, async (tx) => {
    const [c] = await tx
      .insert(customer)
      .values({ tenantId, name: "Nav Lead Customer", phone: "+15555550002" })
      .returning();
    const [p] = await tx
      .insert(property)
      .values({ tenantId, customerId: c!.id, address: "2 Nav Lead Ave" })
      .returning();
    const [l] = await tx
      .insert(lead)
      .values({ tenantId, customerId: c!.id, propertyId: p!.id, status: "new", score: 70, source: "seed" })
      .returning();
    return l!.id;
  });
}

test("job card body click opens the detail page", async ({ page }) => {
  await seedJob();
  await page.goto("/jobs");
  const card = page.getByTestId("job-card").first();
  await expect(card).toBeVisible();
  await expect(card.getByTestId("job-card-grip")).toBeVisible();
  await card.getByTestId("job-card-link").click();
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]+$/);
});

test("job detail shows a breadcrumb that returns to the board", async ({ page }) => {
  await seedJob();
  await page.goto("/jobs");
  await page.getByTestId("job-card-link").first().click();
  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]+$/);
  const crumb = page.getByTestId("breadcrumb");
  await expect(crumb).toBeVisible();
  await crumb.getByRole("link", { name: "Jobs" }).click();
  await expect(page).toHaveURL(/\/jobs$/);
});

test("a stage-scoped jobs URL focuses that board column", async ({ page }) => {
  await seedJob(); // ensure there's at least one job so the board renders
  // The ?stage= deep-link (e.g. from a Pipeline column) focuses that column.
  await page.goto("/jobs?stage=lead");
  await expect(page.getByTestId("col-lead")).toHaveAttribute("data-focused", "true");
});

test("the retired /dashboard route redirects to Today", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/today$/);
});

test("lead detail shows a breadcrumb that returns to the leads list", async ({ page }) => {
  await seedLead();
  await page.goto("/leads");
  // lead-row is the <Link> element itself (data-testid="lead-row"), per the leads page implementation
  const firstLeadRow = page.getByTestId("lead-row").first();
  await firstLeadRow.click();
  await expect(page).toHaveURL(/\/leads\/[0-9a-f-]+$/);
  const crumb = page.getByTestId("breadcrumb");
  await expect(crumb).toBeVisible();
  await crumb.getByRole("link", { name: "Leads" }).click();
  await expect(page).toHaveURL(/\/leads$/);
});
