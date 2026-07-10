/**
 * e2e: the lead-detail RoofTypeEditor captures a primary AND an optional
 * secondary roof type. #82 roof_type_needed stays keyed on primary only —
 * this spec only asserts the save round-trip.
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminDb, customer, property, lead } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

test("sets primary and secondary roof type", async ({ page }) => {
  const stamp = randomUUID().slice(0, 8);
  const [c] = await adminDb.insert(customer).values({ tenantId, name: `Roof Two ${stamp}` }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: `${stamp} Dual Roof Dr` }).returning();
  const [l] = await adminDb.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, source: "test" }).returning();

  await page.goto(`/leads/${l!.id}`);
  await page.getByTestId("roof-type-edit").selectOption("tile");
  await page.getByTestId("roof-type-secondary-edit").selectOption("flat_foam");
  await expect(page.getByText("Saved ✓")).toBeVisible();
});
