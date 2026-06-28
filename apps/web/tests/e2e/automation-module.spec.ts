import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminDb, customer, property, job, jobTask } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

test("automation module: shows autonomy %, needs-you, and per-agent rows", async ({ page }) => {
  const stamp = randomUUID().slice(0, 8);
  const [cust] = await adminDb.insert(customer).values({ tenantId, name: `Auto ${stamp}`, email: `auto-${stamp}@e2e.test` }).returning();
  const [prop] = await adminDb.insert(property).values({ tenantId, customerId: cust!.id, address: `${stamp} Auto Way` }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: cust!.id, propertyId: prop!.id, type: "retail", stage: "production" }).returning();
  const jobId = j!.id;
  // 2 full (1 done, 1 pending) + 2 manual pending across 3 agents
  // autonomyPct = round((2 + 0*0.5) / 4 * 100) = 50%
  // needsYouCount = not-done AND not-full = 2 (the two manual/pending tasks)
  // byAgent = comms, scheduling, finance => 3 rows
  await adminDb.insert(jobTask).values([
    { tenantId, jobId, key: "t1", title: "Send welcome", ownerAgent: "comms", automationLevel: "full", status: "done" },
    { tenantId, jobId, key: "t2", title: "Collect deposit", ownerAgent: "comms", automationLevel: "manual", status: "pending" },
    { tenantId, jobId, key: "t3", title: "Book crew", ownerAgent: "scheduling", automationLevel: "full", status: "pending" },
    { tenantId, jobId, key: "t4", title: "Send invoice", ownerAgent: "finance", automationLevel: "manual", status: "pending" },
  ]);

  await page.goto(`/jobs/${jobId}`);
  await expect(page.getByTestId("automation-module")).toBeVisible();
  await expect(page.getByTestId("autonomy-pct")).toHaveText("50%");
  await expect(page.getByTestId("needs-you-count")).toHaveText("2");
  await expect(page.getByTestId("automation-agent-row")).toHaveCount(3);
});
