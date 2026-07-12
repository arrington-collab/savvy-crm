import { test, expect } from "@playwright/test";

// Runs ONLY in the `demo` Playwright project (see playwright.config.ts), whose baseURL is
// the second webServer (:3001). That server boots with TEST_TENANT_ID = the isolated demo
// tenant seeded by tests/e2e/seed-demo-tenant.ts BEFORE `playwright test` — so getTenantId()
// resolves the demo tenant and /jobs renders ITS full pipeline. Nothing here reads a tenant
// id (the server already owns it) and nothing runs at import time, so collection can't throw
// even when the demo project is absent (no DEMO_TENANT_ID). The full demo pipeline lives in
// its OWN tenant precisely so its costed jobs + this-month invoices never pollute the shared
// e2e tenant's money-console "est —" assertion.

// Mirrors the /jobs board's own stage list (apps/web/src/app/(app)/jobs/board.tsx
// ACTIVE_STAGES) — every non-terminal, non-"lost" pipeline column the board renders.
const PIPELINE_STAGES = ["lead", "inspected", "estimate", "approved", "production", "closeout", "billing", "complete"];

test("demo tenant renders a card in every pipeline column", async ({ page }) => {
  await page.goto("/jobs");
  await expect(page.getByTestId("board")).toBeVisible();

  for (const stage of PIPELINE_STAGES) {
    const column = page.locator(`[data-testid="col-${stage}"]`);
    await expect(column, `column "${stage}" should be visible`).toBeVisible();
    const card = column.locator('[data-testid="job-card"]').first();
    await expect(card, `column "${stage}" should have at least one job card`).toBeVisible();
  }
});
