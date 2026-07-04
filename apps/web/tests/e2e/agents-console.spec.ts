/**
 * e2e: the Operator Console Agents screen (contract cell 5, slice 4).
 *
 * Proves the roster (one card per persona) renders with the audit-principle
 * panel + locked Phase-25 tile, that a seeded agent_run rolls up into its
 * resolved persona's 24h activity, and that the locked tile reveals its thesis.
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { adminDb, agentRun } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

test("Agents roster renders 7 persona cards + audit principle + locked tile", async ({ page }) => {
  await page.goto("/agents");
  await expect(page.getByTestId("agents-page")).toBeVisible();
  await expect(page.getByTestId("roster-card")).toHaveCount(7);
  await expect(page.getByTestId("audit-principle")).toBeVisible();
  await expect(page.getByTestId("locked-tile")).toBeVisible();
  await expect(page.getByTestId("telemetry-link")).toBeVisible();
});

test("a seeded finance/invoice run rolls up into RAINE's 24h activity", async ({ page }) => {
  // finance + a taskKey matching /invoice|payment|collect/ resolves to RAINE (Collections).
  await adminDb.insert(agentRun).values({ tenantId, agent: "finance", taskKey: "invoice.dunning", status: "ok" });

  await page.goto("/agents");
  const raineActions = page.getByTestId("actions-RAINE");
  await expect(raineActions).toBeVisible();
  await expect(raineActions).not.toHaveText("0"); // the seeded run counted
});

test("the locked Phase-25 tile reveals its thesis on click", async ({ page }) => {
  await page.goto("/agents");
  const tile = page.getByTestId("locked-tile");
  await expect(tile).toContainText("Labor Supply");
  await expect(page.getByTestId("locked-thesis")).toHaveCount(0); // hidden until clicked
  await tile.getByRole("button").click();
  await expect(page.getByTestId("locked-thesis")).toBeVisible();
});
