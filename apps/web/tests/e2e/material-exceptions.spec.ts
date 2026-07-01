/**
 * e2e: material-delivery exceptions (D2b).
 *
 * Seeds (a) a MISALIGNED order — a scheduled crew appointment at T plus a
 * material_order whose neededByAt is T+1d (so the delivery target is after the
 * install) — and (b) a NO-INSTALL order — a material_order on a job with no crew
 * appointment. Then asserts /exceptions renders a "Materials" exception row for
 * each seeded (stamped) customer with the right detail + severity.
 *
 * Rows are seeded via adminDb (no R2 / no UI). Assertions scope to the stamped
 * customer names because the page aggregates ALL tenant rows.
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminDb, customer, property, job, estimate, appointment, materialOrder } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

// EstimateLineItem requires category; MaterialOrderLine does not.
const EST_LINE_ITEMS = [
  { key: "shingles", name: "Shingles", category: "material" as const, unit: "square" as const, quantity: 30, unitPriceCents: 12000, amountCents: 360000 },
];
const MAT_LINE_ITEMS = [
  { key: "shingles", name: "Shingles", unit: "square" as const, quantity: 30, unitPriceCents: 12000, amountCents: 360000 },
];

/** Seed a job + accepted estimate, return jobId + customerName. */
async function seedJob(stamp: string, label: string): Promise<{ jobId: string; estimateId: string; name: string }> {
  const name = `${label} ${stamp}`;
  const [cust] = await adminDb.insert(customer).values({ tenantId, name, email: `${label}-${stamp}@e2e.test` }).returning();
  const [prop] = await adminDb.insert(property).values({ tenantId, customerId: cust!.id, address: `${stamp} ${label} Way`, roofType: "asphalt_shingle" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: cust!.id, propertyId: prop!.id, type: "retail", stage: "production" }).returning();
  const [est] = await adminDb.insert(estimate).values({ tenantId, jobId: j!.id, status: "accepted", lineItems: EST_LINE_ITEMS, total: 360000, acceptedAt: new Date() }).returning();
  return { jobId: j!.id, estimateId: est!.id, name };
}

test("material exceptions: misaligned and no-install orders surface on /exceptions", async ({ page }) => {
  const stamp = randomUUID().slice(0, 8);

  // (a) MISALIGNED: crew install at T, materials needed by T+1d (after install).
  const misa = await seedJob(stamp, "Misaligned");
  const install = new Date(Date.now() + 8 * 86_400_000);
  await adminDb.insert(appointment).values({ tenantId, jobId: misa.jobId, type: "crew", status: "scheduled", startsAt: install, endsAt: new Date(install.getTime() + 3_600_000) });
  await adminDb.insert(materialOrder).values({
    tenantId, jobId: misa.jobId, estimateId: misa.estimateId, status: "ordered",
    lineItems: MAT_LINE_ITEMS, subtotalCents: 360000, neededByAt: new Date(install.getTime() + 86_400_000),
  });

  // (b) NO-INSTALL: material order, no crew appointment.
  const noin = await seedJob(stamp, "NoInstall");
  await adminDb.insert(materialOrder).values({
    tenantId, jobId: noin.jobId, estimateId: noin.estimateId, status: "draft",
    lineItems: MAT_LINE_ITEMS, subtotalCents: 360000, neededByAt: new Date(Date.now() + 5 * 86_400_000),
  });

  await page.goto("/exceptions");
  await expect(page.getByTestId("exceptions-page")).toBeVisible();

  // Misaligned row: high severity, "Materials arrive after install".
  const misaRow = page.locator('[data-testid="exception-row"]', { hasText: misa.name });
  await expect(misaRow).toContainText("Materials");
  await expect(misaRow).toContainText("Materials arrive after install");
  await expect(misaRow).toHaveAttribute("data-severity", "high");

  // No-install row: medium severity, "No install scheduled for materials".
  const noinRow = page.locator('[data-testid="exception-row"]', { hasText: noin.name });
  await expect(noinRow).toContainText("No install scheduled for materials");
  await expect(noinRow).toHaveAttribute("data-severity", "medium");
});
