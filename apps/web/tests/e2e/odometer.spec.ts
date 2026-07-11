import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { adminDb, agentRun } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

// Reads the odometer's current actions + minutes, tolerating every state the
// component can render: "quiet" (no numbers) and "counting" with zero minutes
// (the minutes clause is omitted when view.minutes === 0). This keeps the test
// robust whether the shared tenant starts empty or already has activity.
async function readOdometer(page: Page): Promise<{ actions: number; minutes: number }> {
  await page.goto("/today");
  const odometer = page.getByTestId("odometer");
  await expect(odometer).toBeVisible();
  const mode = await odometer.getAttribute("data-mode");
  const actions = mode === "counting" ? Number((await page.getByTestId("odometer-actions").textContent())?.trim()) : 0;
  const minutesEl = page.getByTestId("odometer-minutes");
  const minutes = (await minutesEl.count()) > 0 ? Number((await minutesEl.textContent())?.replace(/[^\d]/g, "")) : 0;
  return { actions, minutes };
}

// Proves the honesty model by measuring OUR OWN delta across seeds (deterministic
// and falsifiable on the shared tenant): ok runs credit EXACTLY their config
// minutes, and a skipped run is counted as an action but credits ZERO minutes.
test("odometer credits ok-run minutes exactly and a skipped run adds an action but 0 minutes", async ({ page }) => {
  // Reduced motion → count-up short-circuits to the final value, so reads are stable.
  await page.emulateMedia({ reducedMotion: "reduce" });

  const before = await readOdometer(page);

  // Seed known ok runs: 2×ops.digest (10m) + 1×estimate.generate (20m) = +40 min, +3 actions.
  await adminDb.insert(agentRun).values([
    { tenantId, agent: "orchestrator", taskKey: "ops.digest", status: "ok", modelUsed: null },
    { tenantId, agent: "orchestrator", taskKey: "ops.digest", status: "ok", modelUsed: null },
    { tenantId, agent: "orchestrator", taskKey: "estimate.generate", status: "ok", modelUsed: null },
  ]);

  const afterOk = await readOdometer(page);
  expect(afterOk.minutes - before.minutes).toBe(40); // exact: ok runs credit their config minutes, nothing more
  expect(afterOk.actions - before.actions).toBe(3);

  // Seed ONE skipped run — it must add an ACTION but ZERO minutes (the core honesty rule).
  await adminDb.insert(agentRun).values([
    { tenantId, agent: "comms", taskKey: "lead.rep.alert", status: "skipped", modelUsed: null, error: "quiet-hours" },
  ]);

  const afterSkip = await readOdometer(page);
  expect(afterSkip.actions - afterOk.actions).toBe(1); // skipped IS an action — the machine still worked
  expect(afterSkip.minutes).toBe(afterOk.minutes); // …but credits NO founder-minutes — falsifiable proof

  // Methodology tooltip cites real, config-derived equivalents (count-independent per-each rate + verb).
  const methodology = page.getByTestId("odometer-methodology");
  await expect(methodology).toContainText("How this is counted");
  await expect(methodology).toContainText("drafted an estimate");
  await expect(methodology).toContainText("· 20m =");
});
