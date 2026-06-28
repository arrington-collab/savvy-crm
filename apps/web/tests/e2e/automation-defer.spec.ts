/**
 * e2e: agent-deferred tasks surface in /exceptions (C Part 2).
 *
 * Seeds a job_task with deferred_at set (as gateAgentAutomation would on a
 * manual/partial task) and asserts the /exceptions page renders a "Needs
 * approval" row for the stamped customer. Seeded via adminDb; assertions scope
 * to the stamped name (the page aggregates ALL tenant rows).
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminDb, customer, property, job, jobTask, eq } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

test("a deferred task appears as a Needs approval exception", async ({ page }) => {
  const stamp = randomUUID().slice(0, 8);
  const name = `Defer Dan ${stamp}`;
  const [cust] = await adminDb.insert(customer).values({ tenantId, name, email: `defer-${stamp}@e2e.test` }).returning();
  const [prop] = await adminDb.insert(property).values({ tenantId, customerId: cust!.id, address: `${stamp} Defer Way` }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: cust!.id, propertyId: prop!.id, type: "retail", stage: "estimate" }).returning();
  await adminDb.insert(jobTask).values({
    tenantId, jobId: j!.id, key: "estimating-049", title: "Estimate import",
    automationLevel: "manual", status: "pending", deferredAt: new Date(),
  });

  await page.goto("/exceptions");
  await expect(page.getByTestId("exceptions-page")).toBeVisible();

  const row = page.locator('[data-testid="exception-row"]', { hasText: name });
  await expect(row).toContainText("Needs approval");
  await expect(row).toContainText("Needs approval: Estimate import");
  await expect(row).toHaveAttribute("data-severity", "medium");
});
