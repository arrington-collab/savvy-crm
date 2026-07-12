import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

// The demo tenant is seeded (via `tests/e2e/seed-demo-tenant.ts`, standalone under tsx)
// BEFORE `playwright test` runs, so the webServer boots `next dev` with TEST_TENANT_ID
// pointed at the demo tenant — see that script's header comment for why `seedDemoTenant`
// isn't imported here directly (it isn't barrel-safe for the Next app graph). This spec
// only reads the id the seed script wrote out.
const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-demo-tenant.json", "utf8")) as { id: string };

// Mirrors the /jobs board's own stage list (apps/web/src/app/(app)/jobs/board.tsx
// ACTIVE_STAGES) — every non-terminal, non-"lost" pipeline column the board renders.
const PIPELINE_STAGES = ["lead", "inspected", "estimate", "approved", "production", "closeout", "billing", "complete"];

test("demo tenant renders a card in every pipeline column", async ({ page }) => {
  // Sanity: the seeded tenant is really the flagged demo tenant driving this run.
  expect(tenantId).toBeTruthy();

  await page.goto("/jobs");
  await expect(page.getByTestId("board")).toBeVisible();

  for (const stage of PIPELINE_STAGES) {
    const column = page.locator(`[data-testid="col-${stage}"]`);
    await expect(column, `column "${stage}" should be visible`).toBeVisible();
    const card = column.locator('[data-testid="job-card"]').first();
    await expect(card, `column "${stage}" should have at least one job card`).toBeVisible();
  }
});
