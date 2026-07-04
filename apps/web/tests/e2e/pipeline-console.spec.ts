/**
 * e2e: the Operator Console Pipeline board (contract cell 5, slice 2).
 *
 * Proves the merged lead→paid board: a job renders in its mapped column with a
 * waiting-on line, an open lead renders in the lead column (jobs + leads on one
 * board), and the filter chips (claims / $25k+) narrow the set. Seeded via
 * adminDb; assertions scope to a stamped name (the board aggregates all rows).
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminDb, customer, property, job, lead, jobChecklistItem } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

test("Pipeline merges jobs + leads onto one board with waiting-on lines", async ({ page }) => {
  const stamp = randomUUID().slice(0, 8);

  // An insurance job in 'estimate' with a pending manual checklist item → shows
  // in the Estimate column, flagged as a claim, waiting on a human.
  const [jc] = await adminDb.insert(customer).values({ tenantId, name: `PJob ${stamp}`, email: `pjob-${stamp}@e2e.test` }).returning();
  const [jp] = await adminDb.insert(property).values({ tenantId, customerId: jc!.id, address: `${stamp} Pipe St` }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: jc!.id, propertyId: jp!.id, type: "insurance", stage: "estimate", valueEstimate: 32750_00 }).returning();
  await adminDb.insert(jobChecklistItem).values({ tenantId, jobId: j!.id, key: "est-1", title: `Approve estimate ${stamp}`, ownerAgent: "finance", automationLevel: "manual", status: "pending" });

  // An open lead → shows in the Lead column (no $).
  const [lc] = await adminDb.insert(customer).values({ tenantId, name: `PLead ${stamp}`, email: `plead-${stamp}@e2e.test` }).returning();
  const [lp] = await adminDb.insert(property).values({ tenantId, customerId: lc!.id, address: `${stamp} Lead Ln` }).returning();
  await adminDb.insert(lead).values({ tenantId, customerId: lc!.id, propertyId: lp!.id, status: "new", score: 70, source: "seed" });

  await page.goto("/pipeline");
  await expect(page.getByTestId("pipeline-page")).toBeVisible();

  // Job card lands in the Estimate column with its waiting-on line + owner.
  const jobCard = page.getByTestId("pipeline-card").filter({ hasText: `PJob ${stamp}` });
  await expect(jobCard).toHaveAttribute("data-column", "estimate");
  await expect(jobCard).toContainText(`Approve estimate ${stamp}`);
  await expect(jobCard).toContainText("You"); // manual task → a human owes it

  // Lead card lands in the Lead column (jobs + leads merged).
  const leadCard = page.getByTestId("pipeline-card").filter({ hasText: `PLead ${stamp}` });
  await expect(leadCard).toHaveAttribute("data-column", "lead");
  await expect(leadCard).toHaveAttribute("data-kind", "lead");
});

test("filter chips narrow the board (claims / $25k+)", async ({ page }) => {
  const stamp = randomUUID().slice(0, 8);
  const [c] = await adminDb.insert(customer).values({ tenantId, name: `PFilter ${stamp}`, email: `pf-${stamp}@e2e.test` }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: `${stamp} Filter Way` }).returning();
  // $32.75k insurance job → matches both Claims and $25k+.
  await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "insurance", stage: "approved", valueEstimate: 32750_00 });

  await page.goto("/pipeline");
  const card = page.getByTestId("pipeline-card").filter({ hasText: `PFilter ${stamp}` });
  await expect(card).toBeVisible();

  // Claims filter keeps it (insurance job).
  await page.getByTestId("chip-claims").click();
  await expect(card).toBeVisible();

  // $25k+ filter keeps it (value ≥ $25k).
  await page.getByTestId("chip-over_25k").click();
  await expect(card).toBeVisible();
});
