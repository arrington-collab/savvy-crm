import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminDb, agentRun, customer, property, job } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

test("activity feed renders rows and filters by outcome", async ({ page }) => {
  const stamp = randomUUID().slice(0, 8);
  await adminDb.insert(agentRun).values([
    { tenantId, agent: "finance", taskKey: "change-order.auto-send-invoice", status: "ok", modelUsed: null },
    { tenantId, agent: "comms", taskKey: `activity-feed.e2e-error-${stamp}`, status: "error", modelUsed: null, error: "boom" },
  ]);

  await page.goto("/activity");

  await expect(page.getByRole("heading", { name: /activity/i })).toBeVisible();
  await expect(page.getByTestId("activity-row").first()).toBeVisible();

  await page.getByTestId("filter-status-error").click();
  await expect(page).toHaveURL(/status=error/);
});

test("activity feed deep-links a single job via ?job=", async ({ page }) => {
  const stamp = randomUUID().slice(0, 8);
  const [cust] = await adminDb
    .insert(customer)
    .values({ tenantId, name: `Activity Feed ${stamp}`, email: `activity-feed-${stamp}@e2e.test` })
    .returning();
  const [prop] = await adminDb
    .insert(property)
    .values({ tenantId, customerId: cust!.id, address: `${stamp} Feed Way` })
    .returning();
  const [j] = await adminDb
    .insert(job)
    .values({ tenantId, customerId: cust!.id, propertyId: prop!.id, type: "retail", stage: "production" })
    .returning();
  const jobId = j!.id;

  await adminDb.insert(agentRun).values({
    tenantId,
    agent: "scheduling",
    jobId,
    taskKey: `activity-feed.e2e-job-${stamp}`,
    status: "ok",
    modelUsed: null,
  });

  await page.goto(`/activity?job=${jobId}`);
  await expect(page.getByTestId("activity-row").first()).toBeVisible();
});
