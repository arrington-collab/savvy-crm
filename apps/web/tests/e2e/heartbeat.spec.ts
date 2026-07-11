import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { adminDb, withTenant, customer, property, job, lead, agentRun } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

test("a job with no touch in COLD_DAYS shows a cold badge linking to its activity; a freshly-touched job does not", async ({ page }) => {
  // Cold job: created 10 days ago, no agent_run/comm/appointment.
  const { coldId, warmId, coldLeadId, contactedLeadId } = await withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name: "Heartbeat HO" }).returning();
    const [p] = await tx.insert(property).values({ tenantId, customerId: c.id, address: "1 Heartbeat Way, Mesa AZ" }).returning();
    const old = new Date(Date.now() - 10 * 86_400_000);
    const [cold] = await tx.insert(job).values({ tenantId, customerId: c.id, propertyId: p.id, stage: "production", createdAt: old, stageEnteredAt: old }).returning();
    const [warm] = await tx.insert(job).values({ tenantId, customerId: c.id, propertyId: p.id, stage: "production" }).returning();
    // Cold lead: created 12 days ago, never touched.
    const [coldLead] = await tx.insert(lead).values({ tenantId, customerId: c.id, propertyId: p.id, status: "new", source: "seed", createdAt: new Date(Date.now() - 12 * 86_400_000) }).returning();
    // Rep-contacted lead: created 15 days ago, no note/appt/agent_run, but "Log
    // Contact" was clicked today (firstRepContactAt) → must NOT read cold.
    const [contactedLead] = await tx.insert(lead).values({ tenantId, customerId: c.id, propertyId: p.id, status: "new", source: "seed", createdAt: new Date(Date.now() - 15 * 86_400_000), firstRepContactAt: new Date() }).returning();
    return { coldId: cold.id, warmId: warm.id, coldLeadId: coldLead.id, contactedLeadId: contactedLead.id };
  });
  // Give the warm job a fresh agent_run touch.
  await adminDb.insert(agentRun).values({ tenantId, agent: "orchestrator", taskKey: "ops.digest", status: "ok", jobId: warmId });

  // --- Job BOARD cards (Task 5) ---
  await page.goto("/jobs");
  const coldCard = page.locator(`[data-job-id="${coldId}"]`);
  const warmCard = page.locator(`[data-job-id="${warmId}"]`);

  // On board cards the badge is a non-link <span> (the card itself is already an
  // <a>); the deep-link lives on the detail header (asserted below).
  await expect(coldCard.getByTestId("heartbeat-cold")).toBeVisible();
  await expect(coldCard.locator("a[data-testid='heartbeat-cold']")).toHaveCount(0); // not a nested anchor
  await expect(coldCard.getByTestId("heartbeat-label")).toHaveText("no activity yet");

  await expect(warmCard.getByTestId("heartbeat-cold")).toHaveCount(0); // freshly touched → not cold
  await expect(warmCard.getByTestId("heartbeat-label")).not.toHaveText("no activity yet");

  // --- Job DETAIL header (Task 8) ---
  await page.goto(`/jobs/${coldId}`);
  const jobDetail = page.getByTestId("heartbeat-cold").first();
  await expect(jobDetail).toBeVisible();
  await expect(jobDetail).toHaveAttribute("href", `/activity?job=${coldId}`);

  // --- Lead DETAIL header (Task 8) + the ?lead= deep-link (Task 2) ---
  await page.goto(`/leads/${coldLeadId}`);
  const leadDetail = page.getByTestId("heartbeat-cold").first();
  await expect(leadDetail).toBeVisible();
  await expect(leadDetail).toHaveAttribute("href", `/activity?lead=${coldLeadId}`);

  // --- Honesty: a lead contacted via firstRepContactAt (Log Contact) is NOT cold ---
  await page.goto(`/leads/${contactedLeadId}`);
  await expect(page.getByTestId("heartbeat")).toBeVisible();
  await expect(page.getByTestId("heartbeat-cold")).toHaveCount(0); // rep-contacted → not cold
});
