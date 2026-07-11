import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { adminDb, withTenant, customer, property, job, agentRun } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

test("a job with no touch in COLD_DAYS shows a cold badge linking to its activity; a freshly-touched job does not", async ({ page }) => {
  // Cold job: created 10 days ago, no agent_run/comm/appointment.
  const { coldId, warmId } = await withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name: "Heartbeat HO" }).returning();
    const [p] = await tx.insert(property).values({ tenantId, customerId: c.id, address: "1 Heartbeat Way, Mesa AZ" }).returning();
    const old = new Date(Date.now() - 10 * 86_400_000);
    const [cold] = await tx.insert(job).values({ tenantId, customerId: c.id, propertyId: p.id, stage: "production", createdAt: old, stageEnteredAt: old }).returning();
    const [warm] = await tx.insert(job).values({ tenantId, customerId: c.id, propertyId: p.id, stage: "production" }).returning();
    return { coldId: cold.id, warmId: warm.id };
  });
  // Give the warm job a fresh agent_run touch.
  await adminDb.insert(agentRun).values({ tenantId, agent: "orchestrator", taskKey: "ops.digest", status: "ok", jobId: warmId });

  await page.goto("/jobs");
  const coldCard = page.locator(`[data-job-id="${coldId}"]`);
  const warmCard = page.locator(`[data-job-id="${warmId}"]`);

  await expect(coldCard.getByTestId("heartbeat-cold")).toBeVisible();
  await expect(coldCard.getByTestId("heartbeat-cold")).toHaveAttribute("href", `/activity?job=${coldId}`);
  await expect(coldCard.getByTestId("heartbeat-label")).toHaveText("no activity yet");

  await expect(warmCard.getByTestId("heartbeat-cold")).toHaveCount(0); // freshly touched → not cold
  await expect(warmCard.getByTestId("heartbeat-label")).not.toHaveText("no activity yet");
});
