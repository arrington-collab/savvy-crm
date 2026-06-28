import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminDb, user, customer, property, job, appointment } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

test("capacity page shows per-rep utilization for the next 7 days", async ({ page }) => {
  const stamp = randomUUID().slice(0, 8);
  const [rep] = await adminDb.insert(user).values({ tenantId, name: `Rep ${stamp}`, email: `rep-${stamp}@e2e.test`, role: "rep" }).returning();
  const [cust] = await adminDb.insert(customer).values({ tenantId, name: `Cap ${stamp}`, email: `cap-${stamp}@e2e.test` }).returning();
  const [prop] = await adminDb.insert(property).values({ tenantId, customerId: cust!.id, address: `${stamp} Cap Way` }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: cust!.id, propertyId: prop!.id, type: "retail", stage: "production" }).returning();
  // One 270-minute appointment 2 days out (inside the 7-day window) → 270/2700 = 10%.
  const start = new Date(Date.now() + 2 * 86_400_000);
  const end = new Date(start.getTime() + 270 * 60_000);
  await adminDb.insert(appointment).values({ tenantId, jobId: j!.id, customerId: cust!.id, assigneeUserId: rep!.id, type: "inspection", status: "scheduled", startsAt: start, endsAt: end });

  await page.goto(`/capacity`);
  await expect(page.getByTestId("capacity-page")).toBeVisible();
  const row = page.getByTestId("capacity-rep").filter({ hasText: `Rep ${stamp}` });
  await expect(row).toBeVisible();
  await expect(row.getByTestId("rep-utilization")).toHaveText("10%");
  await expect(row).toContainText("1 appts");
});
