import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminDb, customer, property, job, invoice, appointment, jobChecklistItem } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

test("exceptions queue lists at-risk job, overdue invoice, missed appt, overdue task", async ({ page }) => {
  const stamp = randomUUID().slice(0, 8);
  const [cust] = await adminDb.insert(customer).values({ tenantId, name: `Exc ${stamp}`, email: `exc-${stamp}@e2e.test` }).returning();
  const [prop] = await adminDb.insert(property).values({ tenantId, customerId: cust!.id, address: `${stamp} Exc Way`, roofType: "asphalt_shingle" }).returning();
  // Stuck job: in production well past the 14d threshold.
  const longAgo = new Date(Date.now() - 30 * 86_400_000);
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: cust!.id, propertyId: prop!.id, type: "retail", stage: "production", stageEnteredAt: longAgo }).returning();
  const jobId = j!.id;
  const past = new Date(Date.now() - 5 * 86_400_000);
  await adminDb.insert(invoice).values({ tenantId, jobId, customerId: cust!.id, status: "overdue", amountDue: 250000, dueAt: past });
  await adminDb.insert(appointment).values({ tenantId, jobId, customerId: cust!.id, type: "crew", status: "no_show", startsAt: past, endsAt: new Date(past.getTime() + 3_600_000) });
  await adminDb.insert(jobChecklistItem).values({ tenantId, jobId, key: "x", title: "Order materials", status: "pending", dueAt: past });

  await page.goto(`/exceptions`);
  await expect(page.getByTestId("exceptions-page")).toBeVisible();
  // At least our four seeded exceptions are present (other tenants' rows may add more — assert >= 4 of ours by detail text).
  await expect(page.getByTestId("exception-row").filter({ hasText: `Exc ${stamp}` })).toHaveCount(4);
  await expect(page.getByTestId("exception-row").filter({ hasText: "Invoice overdue" }).first()).toBeVisible();
});
