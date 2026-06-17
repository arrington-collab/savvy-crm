import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { adminDb, createChangeOrder, customer, property, job } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

test("change order: draft line items with AI from a plain-English description", async ({ page }) => {
  const stamp = Date.now();
  const [c] = await adminDb
    .insert(customer)
    .values({ tenantId, name: `AI Carl ${stamp}`, email: `ai-${stamp}@e2e.test` })
    .returning();
  const [p] = await adminDb
    .insert(property)
    .values({ tenantId, customerId: c!.id, address: `${stamp} AI Way` })
    .returning();
  const [j] = await adminDb
    .insert(job)
    .values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production", valueFinal: 100000 })
    .returning();
  const co = await createChangeOrder({ tenantId, jobId: j!.id, customerId: c!.id, reason: "AI", lineItems: [] });

  await page.goto(`/jobs/${j!.id}/change-orders/${co.id}`);
  await expect(page.getByTestId("change-order-editor")).toBeVisible();

  await page.getByTestId("ai-draft-input").fill("replace 2 pipe boots");
  await page.getByTestId("ai-draft-btn").click();

  // The request-aware AI stub returns the "pipe-boots" key; the server resolves it
  // against the price book and the editor appends a "Pipe boots" line for review.
  await expect(page.getByText("Pipe boots").first()).toBeVisible();
});
