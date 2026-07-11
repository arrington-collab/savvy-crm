import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { adminDb, taskRegistry, verificationRun } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

test("a coverage cell flips to pass and toasts when a check is genuinely earned", async ({ page }) => {
  const [reg] = await adminDb.select({ id: taskRegistry.id }).from(taskRegistry).limit(1);
  // Unique per run so the test is isolated from any pre-existing verification_run rows.
  const checkKey = `e2e.coverage.${Date.now()}`;

  // Seed a FAILING row so SSR renders the panel with this cell as fail (the client
  // poller's "previous" state).
  await adminDb.insert(verificationRun).values({
    tenantId,
    taskId: reg!.id,
    checkKey,
    status: "fail",
    details: { message: "seeded fail" },
    ranAt: new Date(),
  });

  // Deterministically drive the poll: intercept /api/coverage and return the real
  // rows with THIS cell flipped to pass. This exercises the client transition (glow +
  // toast) without racing a DB write against the 15s poll under CI load. coverageWins
  // (unit-tested) is the honesty gate; the SSR render covers the DB→proof query.
  await page.route("**/api/coverage", async (route) => {
    const res = await route.fetch();
    const rows = (await res.json()) as { checkKey: string; status: string }[];
    await route.fulfill({ json: rows.map((r) => (r.checkKey === checkKey ? { ...r, status: "pass" } : r)) });
  });

  await page.goto("/money");
  const row = page.locator(`[data-testid="proof-row"][data-checkkey="${checkKey}"]`);
  await expect(row).toBeVisible();

  // The cell flip is the persistent proof of the transition (survives auto-retry);
  // the toast is the ephemeral celebration on the same poll tick.
  await expect(row).toHaveAttribute("data-status", "pass", { timeout: 20_000 });
  await expect(page.getByText(/coverage restored/i)).toBeVisible({ timeout: 10_000 });
});
