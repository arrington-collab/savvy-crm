/**
 * e2e: the job-detail Tasks tab renders ONLY job-lifecycle tasks (the
 * task_registry-backed job_task ledger via LedgerTab) — never the old
 * tenant-recurring marketing checklist (job_checklist_item). Seeded via
 * adminDb, mirroring job-ledger-console.spec.ts's pattern.
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminDb, withTenant, customer, property, job, jobTask, jobChecklistItem, taskRegistry, eq } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

// Task 43 = "Homeowner inspection walkthrough" (Manual, per_job, all job types).
// Task 141 = "Payment processing — credit card" (Full Auto, per_job, all job types).
const MANUAL_TASK_ID = 43;
const AUTO_TASK_ID = 141;

test("Tasks tab shows only job-lifecycle tasks; marketing excluded", async ({ page }) => {
  const regs = await adminDb
    .select({ id: taskRegistry.id })
    .from(taskRegistry)
    .where(eq(taskRegistry.id, MANUAL_TASK_ID));
  test.skip(regs.length === 0, "task_registry not seeded in this environment");
  const stamp = randomUUID().slice(0, 8);

  const jobId = await withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name: `LedgerTab ${stamp}`, phone: "+15555552468" }).returning();
    const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: `${stamp} Ledger Tab Rd` }).returning();
    const [j] = await tx.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "inspected" }).returning();

    // (a) a MANUAL registry task — pending, no evidence yet.
    // (b) a FULL_AUTO registry task — done, with evidence, proving the glyph+evidence row.
    await tx.insert(jobTask).values([
      { tenantId, jobId: j!.id, taskId: MANUAL_TASK_ID, status: "pending", owner: "HUMAN" },
      { tenantId, jobId: j!.id, taskId: AUTO_TASK_ID, status: "done", owner: "ATLAS", evidence: { type: "payment", ref: stamp } },
    ]);

    // Out-of-scope marketing row — old job_checklist_item path, must NOT render
    // in the Tasks tab (proves the tab no longer reads this table at all).
    await tx.insert(jobChecklistItem).values({
      tenantId,
      jobId: j!.id,
      key: "seo-content-blog-publishing",
      title: "SEO content & blog publishing",
      phase: "Marketing",
      status: "pending",
      payload: { num: 14 },
    });

    return j!.id;
  });

  await page.goto(`/jobs/${jobId}`);
  await expect(page.getByTestId("job-detail")).toBeVisible();
  await page.getByRole("button", { name: "Tasks" }).click();

  const rows = page.getByTestId("task-row");
  await expect(rows).toHaveCount(2);

  // Manual row: checkbox present, no glyph.
  const manualRow = page.locator('[data-testid="task-row"][data-origin="job"]', { hasText: "Homeowner inspection walkthrough" });
  await expect(manualRow).toBeVisible();
  await expect(manualRow.getByRole("checkbox")).toBeVisible();

  // Auto row: no checkbox, evidence citation visible.
  const autoRow = page.locator('[data-testid="task-row"][data-origin="job"]', { hasText: "Payment processing" });
  await expect(autoRow).toBeVisible();
  await expect(autoRow.getByRole("checkbox")).toHaveCount(0);
  await expect(autoRow.getByTestId("ledger-evidence")).toContainText(`payment:${stamp}`);

  await expect(page.getByTestId("ledger-phase").first()).toBeVisible();

  // The marketing checklist item must never surface in the ledger tab.
  await expect(page.getByText("SEO content & blog publishing")).toHaveCount(0);
});
