/**
 * e2e: the Job Ledger section on the job-detail page (contract cell 5, slice 6).
 *
 * Proves the ledger renders instantiated job_task rows with a progress bar +
 * blocked-by, and that a job with no instantiated tasks falls back to its
 * derived event timeline instead of an empty state. Seeded via adminDb.
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminDb, withTenant, customer, property, job, jobStageEvent, jobTask, taskRegistry, asc } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

test("Job Ledger renders instantiated tasks with a progress bar + blocked-by", async ({ page }) => {
  const regs = await adminDb.select({ id: taskRegistry.id }).from(taskRegistry).orderBy(asc(taskRegistry.id)).limit(3);
  test.skip(regs.length < 3, "task_registry not seeded in this environment");
  const stamp = randomUUID().slice(0, 8);

  const [c] = await adminDb.insert(customer).values({ tenantId, name: `Ledger ${stamp}`, phone: "+15555551234" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: `${stamp} Ledger Rd` }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "inspected" }).returning();
  // Three job_task rows: 2 complete (done + verified) + 1 pending blocked by the first.
  await adminDb.insert(jobTask).values([
    { tenantId, jobId: j!.id, taskId: regs[0]!.id, status: "done", owner: "ATLAS", evidence: { type: "lead", ref: stamp } },
    { tenantId, jobId: j!.id, taskId: regs[1]!.id, status: "verified", owner: "MILO" },
    { tenantId, jobId: j!.id, taskId: regs[2]!.id, status: "pending", owner: "HUMAN", blockedBy: [regs[0]!.id] },
  ]);

  await page.goto(`/jobs/${j!.id}`);
  const ledger = page.getByTestId("job-ledger");
  await expect(ledger).toBeVisible();
  await expect(ledger.getByTestId("ledger-progress")).toContainText("2 of 3 complete");
  await expect(ledger.getByTestId("ledger-row")).toHaveCount(3);
  await expect(ledger.getByTestId("ledger-blocked-by")).toContainText(`#${regs[0]!.id}`);
});

test("a job with no instantiated tasks falls back to its activity timeline", async ({ page }) => {
  const stamp = randomUUID().slice(0, 8);
  const jobId = await withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name: `Old ${stamp}`, phone: "+15555554321" }).returning();
    const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: `${stamp} Old Rd` }).returning();
    const [j] = await tx.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "inspected" }).returning();
    // No job_task rows (predates the registry) — a stage event gives the fallback something to show.
    await tx.insert(jobStageEvent).values({ tenantId, jobId: j!.id, toStage: "inspected", enteredAt: new Date() });
    return j!.id;
  });

  await page.goto(`/jobs/${jobId}`);
  const ledger = page.getByTestId("job-ledger");
  await expect(ledger).toBeVisible();
  await expect(ledger.getByTestId("ledger-timeline-fallback")).toBeVisible();
  await expect(ledger.getByTestId("ledger-row")).toHaveCount(0); // no instantiated task rows
});
