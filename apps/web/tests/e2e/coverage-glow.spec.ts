import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { adminDb, taskRegistry, verificationRun } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

test("a coverage cell flips to pass and toasts when a check is genuinely earned", async ({ page }) => {
  const [reg] = await adminDb.select({ id: taskRegistry.id }).from(taskRegistry).limit(1);
  // Unique per run so the test is isolated from any pre-existing verification_run rows.
  const checkKey = `e2e.coverage.${Date.now()}`;

  // Seed a FAILING latest run so the proof panel renders (the client poller mounts).
  await adminDb.insert(verificationRun).values({
    tenantId,
    taskId: reg!.id,
    checkKey,
    status: "fail",
    details: { message: "seeded fail" },
    ranAt: new Date(Date.now() - 60_000),
  });

  await page.goto("/money");
  const row = page.locator(`[data-testid="proof-row"][data-checkkey="${checkKey}"]`);
  await expect(row).toHaveAttribute("data-status", "fail");

  // Earn it: a newer PASSING run. The /api/coverage poll (15s) should flip the cell
  // and celebrate — only because fail → pass is a real win (coverageWins).
  await adminDb.insert(verificationRun).values({ tenantId, taskId: reg!.id, checkKey, status: "pass", ranAt: new Date() });

  // The cell flip is the persistent proof of the transition (survives auto-retry);
  // the toast is the ephemeral celebration on the same poll tick.
  await expect(row).toHaveAttribute("data-status", "pass", { timeout: 25_000 });
  await expect(page.getByText(/coverage restored/i)).toBeVisible({ timeout: 10_000 });
});
