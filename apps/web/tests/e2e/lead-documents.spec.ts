import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminDb, customer, property, lead, document } from "@savvy/db";

const { id: tenantId } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string; key: string };

test("lead documents: card renders a seeded lead-scoped document", async ({ page }) => {
  const stamp = randomUUID().slice(0, 8);
  const [cust] = await adminDb.insert(customer).values({
    tenantId, name: `Docs Dan ${stamp}`,
  }).returning();
  const [prop] = await adminDb.insert(property).values({
    tenantId, customerId: cust!.id, address: `${stamp} Docs Way`,
  }).returning();
  const [l] = await adminDb.insert(lead).values({
    tenantId, customerId: cust!.id, propertyId: prop!.id, source: "e2e",
  }).returning();
  await adminDb.insert(document).values({
    tenantId, leadId: l!.id, propertyId: prop!.id, customerId: cust!.id,
    kind: "insurance_estimate", r2Key: `${tenantId}/lead/${l!.id}/seed.pdf`,
    filename: "carrier-estimate.pdf", mime: "application/pdf", sizeBytes: 4096,
    source: "savvy", parseStatus: "pending",
  });

  await page.goto(`/leads/${l!.id}`);
  const card = page.getByTestId("lead-docs-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("carrier-estimate.pdf");
  await expect(card).toContainText("Pending"); // parse-status chip
});
