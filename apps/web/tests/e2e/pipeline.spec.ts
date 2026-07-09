import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  adminDb, withTenant, customer, property, job, document, jobChecklistItem, jobStageEvent, seedJobTasks, instantiateJobTasks, eq, and, isNull,
} from "@savvy/db";

const { id: tenantId } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string; key: string };

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 400));
  }
}

// dnd-kit needs a pointer move past the activation distance, then steps to the target.
async function dragCardToColumn(page: Page, jobId: string, toStage: string) {
  // The card body is a <Link> (click = open detail); only the grip handle carries the
  // dnd-kit drag listeners. Press the grip, not the card center, or we just navigate.
  const card = page.locator(`[data-testid="job-card"][data-job-id="${jobId}"]`);
  const grip = card.locator(`[data-testid="job-card-grip"]`);
  const col = page.locator(`[data-testid="col-${toStage}"]`);
  const gb = await grip.boundingBox();
  const tb = await col.boundingBox();
  if (!gb || !tb) throw new Error("grip or column not visible");
  await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
  await page.mouse.down();
  await page.mouse.move(gb.x + gb.width / 2 + 12, gb.y + gb.height / 2 + 12, { steps: 5 }); // pass activation distance
  await page.mouse.move(tb.x + tb.width / 2, tb.y + 40, { steps: 10 });
  await page.mouse.up();
}

test("pipeline: seed job -> board -> drag to inspected -> tasks activate -> detail", async ({ page }) => {
  // Seed a fresh job for the e2e tenant at stage 'lead' with the full lifecycle.
  const jobId = await withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name: "Pipeline Pat", phone: "+15555559000" }).returning();
    const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: "9 Pipeline Way" }).returning();
    const [j] = await tx.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "lead", valueEstimate: 1800000 }).returning();
    await seedJobTasks(tx as never, { id: j!.id, tenantId, type: "retail" });
    // Registry ledger rows (job_task) — this is what the Tasks tab renders now
    // (job_checklist_item, seeded above, only drives phase-activation/due dates).
    await instantiateJobTasks(tx, { tenantId, jobId: j!.id, jobType: "retail" });
    // Evidence gate: the drag below moves the job lead -> inspected, which is a
    // forward transition and requires `inspection` evidence to be present.
    await tx.insert(document).values({ tenantId, jobId: j!.id, kind: "photo", r2Key: `e2e/${j!.id}/inspection.jpg` });
    return j!.id;
  });

  // Board shows the card in the lead column.
  await page.goto("/jobs");
  const card = page.locator(`[data-testid="job-card"][data-job-id="${jobId}"]`);
  await expect(card).toBeVisible();
  await expect(page.locator(`[data-testid="col-lead"] [data-job-id="${jobId}"]`)).toBeVisible();

  // Before the move: inspected-stage tasks are NOT activated (due_at null).
  const inspectedPending = () =>
    withTenant(tenantId, (tx) =>
      tx.select().from(jobChecklistItem).where(and(eq(jobChecklistItem.jobId, jobId), eq(jobChecklistItem.status, "pending"), isNull(jobChecklistItem.dueAt), eq(jobChecklistItem.phase, "Inspection"))),
    );
  expect((await inspectedPending()).length).toBeGreaterThan(0);

  // Drag the card to the inspected column.
  await dragCardToColumn(page, jobId, "inspected");

  // The stage change persisted: job.stage = inspected, a stage event exists.
  await waitFor(async () => {
    const [j] = await withTenant(tenantId, (tx) => tx.select().from(job).where(eq(job.id, jobId)));
    return j?.stage === "inspected" ? j : undefined;
  });
  const events = await withTenant(tenantId, (tx) => tx.select().from(jobStageEvent).where(eq(jobStageEvent.jobId, jobId)));
  expect(events.some((e) => e.toStage === "inspected" && e.fromStage === "lead")).toBe(true);

  // Inspected tasks are now activated (due_at set).
  const activated = await withTenant(tenantId, (tx) =>
    tx.select().from(jobChecklistItem).where(and(eq(jobChecklistItem.jobId, jobId), eq(jobChecklistItem.phase, "Inspection"))),
  );
  expect(activated.length).toBeGreaterThan(0);
  expect(activated.every((t) => t.dueAt !== null)).toBe(true);

  // Detail view renders with the job's tasks.
  await page.goto(`/jobs/${jobId}`);
  await expect(page.getByTestId("job-detail")).toBeVisible();
  await expect(page.getByTestId("task-row").first()).toBeVisible();
});
