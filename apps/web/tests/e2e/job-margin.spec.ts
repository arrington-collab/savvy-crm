import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { withTenant, customer, property, job } from "@savvy/db";

const { id: tenantId } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string };

test("job cockpit shows a real-time Money & margin readout (revenue - cost)", async ({ page }) => {
  // Revenue $30,000 (valueEstimate=3,000,000c) − cost $12,000 (costCents=1,200,000) → margin $18,000 (60%).
  const jobId = await withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name: "Margin Mary" }).returning({ id: customer.id });
    const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: "60 Margin Ave" }).returning({ id: property.id });
    const [j] = await tx
      .insert(job)
      .values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "approved", valueEstimate: 3_000_000, costCents: 1_200_000 })
      .returning({ id: job.id });
    return j!.id;
  });

  await page.goto(`/jobs/${jobId}`);
  const panel = page.getByTestId("job-margin");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(/Money & margin/i);
  await expect(panel).toContainText("$30,000"); // revenue
  await expect(panel).toContainText("$12,000"); // cost
  await expect(panel).toContainText("60%"); // margin pct
  await expect(page.getByTestId("job-margin-amount")).toHaveText("$18,000");
});
