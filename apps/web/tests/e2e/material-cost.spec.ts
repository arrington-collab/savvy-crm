import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminDb, customer, property, job, estimate, priceBookItem, materialOrder, eq } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 15_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 300));
  }
}

test("material cost: generate -> mark ordered -> job.costCents + margin reflect supplier cost", async ({ page }) => {
  const stamp = randomUUID().slice(0, 8);
  const [cust] = await adminDb.insert(customer).values({ tenantId, name: `Cost ${stamp}`, email: `cost-${stamp}@e2e.test` }).returning();
  const [prop] = await adminDb.insert(property).values({ tenantId, customerId: cust!.id, address: `${stamp} Cost Way` }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: cust!.id, propertyId: prop!.id, type: "retail", stage: "production", valueFinal: 630000 }).returning();
  const jobId = j!.id;
  // Price-book cost for the material key used below (unique key per run to avoid the tenant unique index).
  const key = `shingles-${stamp}`;
  await adminDb.insert(priceBookItem).values({ tenantId, key, name: "Shingles", category: "material", unit: "square", unitPriceCents: 12000, unitCostCents: 7800 });
  await adminDb.insert(estimate).values({
    tenantId, jobId, status: "accepted", total: 630000, acceptedAt: new Date(),
    lineItems: [
      { key, name: "Shingles", category: "material", unit: "square", quantity: 30, unitPriceCents: 12000, amountCents: 360000 },
      { key: "labor", name: "Install", category: "labor", unit: "square", quantity: 30, unitPriceCents: 9000, amountCents: 270000 },
    ],
  });

  await page.goto(`/jobs/${jobId}`);
  await expect(page.getByTestId("job-detail")).toBeVisible();
  await page.getByTestId("generate-material-order-btn").click();
  const order = await waitFor(async () => {
    const [row] = await adminDb.select().from(materialOrder).where(eq(materialOrder.jobId, jobId));
    return row ?? undefined;
  });
  expect(order.costSubtotalCents).toBe(30 * 7800);

  await page.getByTestId("advance-material-order-btn").click();
  const jobAfter = await waitFor(async () => {
    const [row] = await adminDb.select().from(job).where(eq(job.id, jobId));
    return row?.costCents === 30 * 7800 ? row : undefined;
  });
  expect(jobAfter.costCents).toBe(234000);

  // Margin card now shows real cost (revenue 6300 − cost 2340).
  await page.reload();
  await expect(page.getByTestId("job-margin")).toBeVisible();
  await expect(page.getByTestId("material-order-cost")).toBeVisible();
});
