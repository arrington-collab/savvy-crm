import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminDb, customer, property, job, estimate, appointment, materialOrder, eq } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

const LINE_ITEMS = [
  { key: "shingles", name: "Shingles", category: "material", unit: "square", quantity: 30, unitPriceCents: 12000, amountCents: 360000 },
  { key: "labor", name: "Install", category: "labor", unit: "square", quantity: 30, unitPriceCents: 9000, amountCents: 270000 },
];

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 15_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 300));
  }
}

test("materials: generate from estimate -> shows material line only -> advance status", async ({ page }) => {
  const stamp = randomUUID().slice(0, 8);
  const [cust] = await adminDb.insert(customer).values({ tenantId, name: `Mat ${stamp}`, email: `mat-${stamp}@e2e.test` }).returning();
  const [prop] = await adminDb.insert(property).values({ tenantId, customerId: cust!.id, address: `${stamp} Mat Way` }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: cust!.id, propertyId: prop!.id, type: "retail", stage: "production" }).returning();
  const jobId = j!.id;
  await adminDb.insert(estimate).values({ tenantId, jobId, status: "accepted", lineItems: LINE_ITEMS, total: 630000, acceptedAt: new Date() });
  const install = new Date(Date.now() + 10 * 86_400_000);
  await adminDb.insert(appointment).values({ tenantId, jobId, type: "crew", status: "scheduled", startsAt: install, endsAt: new Date(install.getTime() + 3_600_000) });

  await page.goto(`/jobs/${jobId}`);
  await expect(page.getByTestId("job-detail")).toBeVisible();
  await page.getByTestId("generate-material-order-btn").click();

  const order = await waitFor(async () => {
    const [row] = await adminDb.select().from(materialOrder).where(eq(materialOrder.jobId, jobId));
    return row ?? undefined;
  });
  expect(order.lineItems.length).toBe(1);
  expect(order.lineItems[0]!.key).toBe("shingles");
  expect(order.subtotalCents).toBe(360000);
  expect(order.neededByAt).not.toBeNull();

  await expect(page.getByTestId("material-order")).toBeVisible();
  await expect(page.getByTestId("material-order-line")).toHaveCount(1);

  await page.getByTestId("advance-material-order-btn").click();
  await waitFor(async () => {
    const [row] = await adminDb.select().from(materialOrder).where(eq(materialOrder.id, order.id));
    return row?.status === "ordered" && row.orderedAt ? row : undefined;
  });
});
