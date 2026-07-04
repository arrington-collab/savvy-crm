/**
 * e2e: the Operator Console Money screen (contract cell 5, slice 3).
 *
 * Proves the headless money surface: KPI grid + AR-aging ladder + commissions
 * accrual render, and the nightly proof-of-correctness panel renders real
 * verification_run rows (status + evidence) — not fabricated. Seeded via adminDb.
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminDb, customer, property, job, invoice, verificationRun, taskRegistry, eq } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

test("Money screen renders the KPI grid, AR ladder, commissions, and proof panel", async ({ page }) => {
  await page.goto("/money");
  await expect(page.getByTestId("money-page")).toBeVisible();
  await expect(page.getByTestId("money-kpis")).toBeVisible();
  await expect(page.getByTestId("ar-ladder")).toBeVisible();
  await expect(page.getByTestId("commissions-panel")).toBeVisible();
  await expect(page.getByTestId("proof-panel")).toBeVisible();
  // GM stays uninstrumented → "est —", never a fabricated %.
  await expect(page.getByTestId("money-kpis")).toContainText("est —");
});

test("GM · MTD shows a real % once a costed job is invoiced this month", async ({ page }) => {
  const stamp = randomUUID().slice(0, 8);
  const [c] = await adminDb.insert(customer).values({ tenantId, name: `GM ${stamp}`, email: `gm-${stamp}@e2e.test` }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: `${stamp} Margin Rd` }).returning();
  // Revenue $10,000 (valueFinal) − cost $6,000 (costCents from supplier actuals) → 40% GM.
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "billing", valueFinal: 1_000_000, costCents: 600_000 }).returning();
  // A non-draft invoice created this month makes the job count toward GM·MTD.
  await adminDb.insert(invoice).values({ tenantId, jobId: j!.id, customerId: c!.id, status: "sent", amountDue: 1_000_000 });

  await page.goto("/money");
  const gm = page.getByTestId("kpi-gm-mtd");
  await expect(gm).toBeVisible();
  await expect(gm).toHaveText(/^\d+%$/); // a real percentage, not "est —"
});

test("a 61+ day overdue invoice ages into the AR ladder's oldest bucket", async ({ page }) => {
  const stamp = randomUUID().slice(0, 8);
  const [c] = await adminDb.insert(customer).values({ tenantId, name: `MInv ${stamp}`, email: `minv-${stamp}@e2e.test` }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: `${stamp} Money Way` }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "billing" }).returning();
  const due70 = new Date(Date.now() - 70 * 86_400_000);
  await adminDb.insert(invoice).values({ tenantId, jobId: j!.id, customerId: c!.id, status: "overdue", amountDue: 14900_00, dueAt: due70 });

  await page.goto("/money");
  // A 61+ invoice exists → the ladder's 61+ note renders and its bar has height.
  await expect(page.getByTestId("ar-ladder")).toContainText("61+ bucket");
});

test("the proof panel renders a real verification_run with its status + evidence", async ({ page }) => {
  const [reg] = await adminDb.select({ id: taskRegistry.id }).from(taskRegistry).limit(1);
  test.skip(!reg, "task_registry not seeded in this environment");
  const stamp = randomUUID().slice(0, 8);
  const checkKey = `zzz.e2e_proof_${stamp}`; // unstyled key → renders raw + sorts under real checks
  await adminDb.insert(verificationRun).values({
    tenantId, taskId: reg!.id, checkKey, status: "fail",
    details: { message: `seeded failure ${stamp}` }, refs: [{ type: "invoice", ref: stamp }],
  });

  await page.goto("/money");
  const row = page.locator('[data-testid="proof-row"]', { hasText: checkKey });
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("data-status", "fail");
  await expect(row).toContainText("FAIL");
  await expect(row).toContainText(`seeded failure ${stamp}`);

  // cleanup so we don't leave a permanent failing check polluting other runs' summaries
  await adminDb.delete(verificationRun).where(eq(verificationRun.checkKey, checkKey));
});
