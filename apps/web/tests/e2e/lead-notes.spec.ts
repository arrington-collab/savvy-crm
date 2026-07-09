/**
 * e2e: quick-add lead notes are append-only and appear in the merged
 * notes/comms feed on the lead detail page.
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminDb, customer, property, lead } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

test("adds a lead note that appears in the feed", async ({ page }) => {
  const stamp = randomUUID().slice(0, 8);
  const [c] = await adminDb.insert(customer).values({ tenantId, name: `Note Lead ${stamp}` }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: `${stamp} Note Ln` }).returning();
  const [l] = await adminDb.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, source: "test" }).returning();

  await page.goto(`/leads/${l!.id}`);
  await page.getByTestId("lead-note-input").fill(`south facet soft decking ${stamp}`);
  await page.getByTestId("lead-note-add").click();
  await expect(page.getByText(`south facet soft decking ${stamp}`)).toBeVisible();
  // input clears on success
  await expect(page.getByTestId("lead-note-input")).toHaveValue("");
});
