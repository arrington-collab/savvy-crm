/**
 * e2e: the Job Ledger section on the job-detail page (contract cell 5, slice 6).
 *
 * Proves the ledger renders instantiated job_task rows with a progress bar, and
 * that a job with no instantiated tasks falls back to its derived event timeline
 * instead of an empty state.
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminDb, withTenant, customer, property, job, jobStageEvent, jobTask, seedJobTasks, eq } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

test("Job Ledger renders instantiated tasks with a progress bar", async ({ page }) => {
  const stamp = randomUUID().slice(0, 8);
  const jobId = await withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name: `Ledger ${stamp}`, phone: "+15555551234" }).returning();
    const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: `${stamp} Ledger Rd` }).returning();
    const [j] = await tx.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "inspected" }).returning();
    await seedJobTasks(tx as never, { id: j!.id, tenantId, type: "retail" });
    return j!.id;
  });
  // Mark one task complete so the progress math is non-trivial (N of M, N ≥ 1).
  const [t] = await adminDb.select({ id: jobTask.id }).from(jobTask).where(eq(jobTask.jobId, jobId)).limit(1);
  await adminDb.update(jobTask).set({ status: "done" }).where(eq(jobTask.id, t!.id));

  await page.goto(`/jobs/${jobId}`);
  const ledger = page.getByTestId("job-ledger");
  await expect(ledger).toBeVisible();
  await expect(ledger.getByTestId("ledger-progress")).toContainText(/\d+ of \d+ complete/);
  expect(await ledger.getByTestId("ledger-row").count()).toBeGreaterThan(0);
});

test("a job with no instantiated tasks falls back to its activity timeline", async ({ page }) => {
  const stamp = randomUUID().slice(0, 8);
  const jobId = await withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name: `Old ${stamp}`, phone: "+15555554321" }).returning();
    const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: `${stamp} Old Rd` }).returning();
    const [j] = await tx.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "inspected" }).returning();
    // No seedJobTasks (predates the registry) — but a stage event gives the fallback something to show.
    await tx.insert(jobStageEvent).values({ tenantId, jobId: j!.id, toStage: "inspected", enteredAt: new Date() });
    return j!.id;
  });

  await page.goto(`/jobs/${jobId}`);
  const ledger = page.getByTestId("job-ledger");
  await expect(ledger).toBeVisible();
  await expect(ledger.getByTestId("ledger-timeline-fallback")).toBeVisible();
  await expect(ledger.getByTestId("ledger-row")).toHaveCount(0); // no instantiated task rows
});
