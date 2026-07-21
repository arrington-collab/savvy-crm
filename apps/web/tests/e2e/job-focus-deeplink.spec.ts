/**
 * e2e: a Today decision-card deep-links to /jobs/{id}?focus=<surface>. The job
 * page must open the matching tab on arrival (so the operator lands on the exact
 * area, not the top of the page). Scoped to a stamped job.
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminDb, customer, property, job } from "@savvy/db";

const tenantId = process.env.TEST_TENANT_ID ?? JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")).id;

async function seedJob(stamp: string): Promise<string> {
  const [c] = await adminDb.insert(customer).values({ tenantId, name: `Focus ${stamp}` }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: `${stamp} Focus St` }).returning();
  const [jb] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
  return jb!.id;
}

test("?focus=docs opens the Docs tab on the job page", async ({ page }) => {
  const jobId = await seedJob(randomUUID().slice(0, 8));
  await page.goto(`/jobs/${jobId}?focus=docs`);
  await expect(page.getByTestId("job-detail")).toBeVisible();
  // Radix marks the active tab aria-selected — the deep-link should have opened Docs.
  await expect(page.locator('#focus-tabs [role="tab"][aria-selected="true"]')).toHaveText(/docs/i);
});

test("no focus param leaves the default Tasks tab active", async ({ page }) => {
  const jobId = await seedJob(randomUUID().slice(0, 8));
  await page.goto(`/jobs/${jobId}`);
  await expect(page.getByTestId("job-detail")).toBeVisible();
  await expect(page.locator('#focus-tabs [role="tab"][aria-selected="true"]')).toHaveText(/tasks/i);
});
