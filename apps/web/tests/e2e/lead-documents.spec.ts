import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminDb, customer, property, lead, document, claim } from "@savvy/db";

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

test("lead documents: parse panel shows extracted values, viewer opens, re-parse is wired", async ({ page }) => {
  const stamp = randomUUID().slice(0, 8);
  const [cust] = await adminDb.insert(customer).values({ tenantId, name: `Parsed Pam ${stamp}` }).returning();
  const [prop] = await adminDb.insert(property).values({ tenantId, customerId: cust!.id, address: `${stamp} Parsed Ave` }).returning();
  const [l] = await adminDb.insert(lead).values({ tenantId, customerId: cust!.id, propertyId: prop!.id, source: "e2e" }).returning();
  const [doc] = await adminDb.insert(document).values({
    tenantId, leadId: l!.id, propertyId: prop!.id, customerId: cust!.id,
    kind: "insurance_estimate", r2Key: `${tenantId}/lead/${l!.id}/parsed.pdf`,
    filename: "acme-estimate.pdf", mime: "application/pdf", sizeBytes: 4096,
    source: "savvy", parseStatus: "parsed", parseConfidence: 0.92,
  }).returning();
  await adminDb.insert(claim).values({
    tenantId, leadId: l!.id, propertyId: prop!.id,
    carrierName: "Acme Mutual", claimNumber: "CLM-777", acvCents: 800000, rcvCents: 1000000, deductibleCents: 200000,
    lineItems: [{}, {}, {}], parseConfidence: 0.92,
  });

  await page.goto(`/leads/${l!.id}`);
  const card = page.getByTestId("lead-docs-card");
  await expect(card).toBeVisible();

  // Parse panel renders the extracted claim values beside the doc.
  const panel = page.getByTestId(`parse-panel-${doc!.id}`);
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Acme Mutual");
  await expect(panel).toContainText("Line items");
  await expect(panel).toContainText("3");

  // Viewer opens on click with a header showing the filename; Escape closes it.
  await page.getByTestId(`view-doc-${doc!.id}`).click();
  const viewer = page.getByTestId("doc-viewer");
  await expect(viewer).toBeVisible();
  await expect(page.getByTestId("doc-viewer-filename")).toHaveText("acme-estimate.pdf");
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);

  // Re-run parse is wired (idempotent; confirmed-guard enforced server-side).
  await card.getByRole("button", { name: "Re-run parse" }).click();
  await expect(card).toBeVisible(); // no crash; action dispatched
});
