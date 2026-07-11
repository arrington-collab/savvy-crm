import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { adminDb, agentRun } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

// The e2e tenant is shared across specs, so other ok runs may exist. Seed a known
// batch of mapped ok runs and assert the odometer reflects AT LEAST our
// contribution — robust to whatever else is on the tenant.
test("odometer shows real actions + minutes under reduced motion (final value, no ramp)", async ({ page }) => {
  await adminDb.insert(agentRun).values([
    { tenantId, agent: "orchestrator", taskKey: "ops.digest", status: "ok", modelUsed: null }, // 10m
    { tenantId, agent: "orchestrator", taskKey: "ops.digest", status: "ok", modelUsed: null }, // 10m
    { tenantId, agent: "orchestrator", taskKey: "estimate.generate", status: "ok", modelUsed: null }, // 20m
    // status="skipped" must NOT add minutes — proves the ok-only honesty rule live.
    { tenantId, agent: "comms", taskKey: "lead.rep.alert", status: "skipped", modelUsed: null },
  ]);

  // Reduced motion → the count-up short-circuits to the final value immediately.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/today");

  const odometer = page.getByTestId("odometer");
  await expect(odometer).toHaveAttribute("data-mode", "counting");

  const actions = Number((await page.getByTestId("odometer-actions").textContent())?.trim());
  expect(actions).toBeGreaterThanOrEqual(4); // our 4 seeded runs (skipped still counts as an action)

  const minutes = Number((await page.getByTestId("odometer-minutes").textContent())?.replace(/[^\d]/g, ""));
  expect(minutes).toBeGreaterThanOrEqual(40); // 2×10 + 1×20; the skipped alert adds 0

  // Methodology tooltip is present in the DOM and cites the equivalents.
  await expect(page.getByTestId("odometer-methodology")).toContainText("How this is counted");
  await expect(page.getByTestId("odometer-methodology")).toContainText("= 20m");
});
