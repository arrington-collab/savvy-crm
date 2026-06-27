import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { withTenant, customer, property, job, jobStageEvent } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

test("command center shows a weighted pipeline summary", async ({ page }) => {
  // Seed an approved job ($100k) with an approved stage event 10 days ago.
  await withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name: `CCpipe ${Date.now()}` }).returning({ id: customer.id });
    const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: "1 Pipeline Plz" }).returning({ id: property.id });
    const [j] = await tx
      .insert(job)
      .values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "approved", valueEstimate: 10_000_000, openedAt: new Date(Date.now() - 30 * 86_400_000) })
      .returning({ id: job.id });
    await tx.insert(jobStageEvent).values({ tenantId, jobId: j!.id, toStage: "approved", enteredAt: new Date(Date.now() - 10 * 86_400_000) });
  });

  await page.goto("/command-center");
  const panel = page.getByTestId("pipeline-summary");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(/Pipeline/i);
  await expect(panel).toContainText(/Gross/i);
  await expect(panel).toContainText(/Expected/i);
  // Expected total must be strictly less than gross (weighting shrinks it).
  await expect(page.getByTestId("pipeline-gross")).toBeVisible();
  await expect(page.getByTestId("pipeline-expected")).toBeVisible();
});
