/**
 * e2e: the lead-detail RoofReplacementEditor captures a last roof-replacement
 * date + source. The server action rejects future dates (see lead-actions.ts).
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminDb, customer, property, lead } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

test("records a roof replacement date + source", async ({ page }) => {
  const stamp = randomUUID().slice(0, 8);
  const [c] = await adminDb.insert(customer).values({ tenantId, name: `Replacement ${stamp}` }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: `${stamp} Replacement Dr` }).returning();
  const [l] = await adminDb.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, source: "test" }).returning();

  await page.goto(`/leads/${l!.id}`);
  await page.getByTestId("roof-replacement-date").fill("2018-05-01");
  await page.getByTestId("roof-replacement-source").selectOption("owner_reported");
  await page.getByTestId("roof-replacement-save").click();
  await expect(page.getByText("Saved ✓")).toBeVisible();
});

test("rejects a future roof replacement date", async ({ page }) => {
  const stamp = randomUUID().slice(0, 8);
  const [c] = await adminDb.insert(customer).values({ tenantId, name: `Replacement ${stamp}` }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: `${stamp} Replacement Dr` }).returning();
  const [l] = await adminDb.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, source: "test" }).returning();

  const futureYear = new Date().getFullYear() + 1;
  await page.goto(`/leads/${l!.id}`);
  await page.getByTestId("roof-replacement-date").fill(`${futureYear}-05-01`);
  await page.getByTestId("roof-replacement-source").selectOption("owner_reported");
  await page.getByTestId("roof-replacement-save").click();
  await expect(page.getByText("replacement date cannot be in the future")).toBeVisible();
  await expect(page.getByText("Saved ✓")).not.toBeVisible();
});
