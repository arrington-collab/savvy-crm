import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { adminDb, agentRun, job, customer, property, eq } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

test("a running agent_run shows typing dots on the job card, gone when stale", async ({ page }) => {
  // Seed a customer + property + job, then an OPEN running run on that job.
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "Inflight Test HO" }).returning();
  const [p] = await adminDb
    .insert(property)
    .values({ tenantId, customerId: c.id, address: "1 Inflight Way, Mesa AZ" })
    .returning();
  const [j] = await adminDb
    .insert(job)
    .values({ tenantId, customerId: c.id, propertyId: p.id, stage: "estimate" })
    .returning();
  const [run] = await adminDb
    .insert(agentRun)
    .values({
      tenantId,
      agent: "orchestrator",
      taskKey: "estimating-049",
      status: "running",
      finishedAt: null,
      jobId: j.id,
    })
    .returning();

  await page.goto("/jobs");
  const card = page.locator(`[data-job-id="${j.id}"]`);
  // Dots appear once the /api/inflight poll (every 15s) picks up the running run.
  await expect(card.getByTestId("inflight-dots")).toBeVisible({ timeout: 20_000 });

  // Stale the run (older than SPINNER_MAX_SECONDS=90s) → shapeInflight drops it,
  // dots should disappear on the next poll.
  await adminDb
    .update(agentRun)
    .set({ startedAt: new Date(Date.now() - 120_000) })
    .where(eq(agentRun.id, run.id));

  await expect(card.getByTestId("inflight-dots")).toBeHidden({ timeout: 20_000 });
});
