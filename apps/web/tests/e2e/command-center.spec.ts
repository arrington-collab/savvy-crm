import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { adminDb, agentRun } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

test("command center renders a seeded agent run and the five agent cards", async ({ page }) => {
  await adminDb.insert(agentRun).values({
    tenantId,
    agent: "finance",
    taskKey: "change-order.auto-send-invoice",
    status: "ok",
    modelUsed: null,
  });

  await page.goto("/command-center");

  await expect(page.getByRole("heading", { name: "Command Center" })).toBeVisible();
  // The activity feed reflects the seeded run (proves the query + render path).
  await expect(page.getByText("change-order.auto-send-invoice").first()).toBeVisible();
  // Coverage always shows all five agents (claims rendered as deferred).
  for (const label of ["Orchestrator", "Comms", "Scheduling", "Finance", "Claims"]) {
    await expect(page.getByText(label, { exact: false }).first()).toBeVisible();
  }
});
