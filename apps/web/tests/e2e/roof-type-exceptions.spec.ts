/**
 * e2e: a post-inspection job whose property has no roof type surfaces in
 * /exceptions ("Roof type"), and setting the roof type on the lead clears it.
 * Scoped to a stamped customer name (the page aggregates ALL tenant rows).
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminDb, customer, property, lead, job } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

async function seedRoofGap(stamp: string): Promise<{ name: string; leadId: string }> {
  const name = `Roof Ron ${stamp}`;
  const [c] = await adminDb.insert(customer).values({ tenantId, name }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: `${stamp} Shingle St` }).returning();
  const [l] = await adminDb.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, source: "test" }).returning();
  await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, leadId: l!.id, type: "retail", stage: "inspected" });
  return { name, leadId: l!.id };
}

test("a post-inspection job with no roof type appears as a Roof type exception", async ({ page }) => {
  const { name } = await seedRoofGap(randomUUID().slice(0, 8));
  await page.goto("/today");
  await expect(page.getByTestId("today-page")).toBeVisible();
  const row = page.locator('[data-testid="decision-card"]', { hasText: name });
  await expect(row).toContainText("Roof type");
});

test("setting the roof type on the lead clears the exception", async ({ page }) => {
  const stamp = randomUUID().slice(0, 8);
  const { name, leadId } = await seedRoofGap(stamp);

  await page.goto(`/leads/${leadId}`);
  await page.getByTestId("roof-type-edit").selectOption("tile");
  await expect(page.getByText("Saved ✓")).toBeVisible();

  await page.goto("/today");
  await expect(page.getByTestId("today-page")).toBeVisible();
  await expect(page.locator('[data-testid="decision-card"]', { hasText: name })).toHaveCount(0);
});
