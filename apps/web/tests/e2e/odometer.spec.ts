import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { adminDb, agentRun } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

// Integration check: the wired-up odometer renders REAL agent_run data under
// reduced motion, and the methodology tooltip cites real config-derived
// equivalents. The exact honesty arithmetic (ok-only credit, skipped/unknown → 0)
// is proven deterministically and in isolation by the unit tests in
// packages/core/src/minutes-saved.test.ts — not re-proven here, because the e2e
// tenant is shared and mutable, so only LOWER-BOUND / presence assertions are
// deterministic (an exact-delta would flake when parallel specs write runs).
test("odometer renders real actions + minutes under reduced motion, with a methodology tooltip", async ({ page }) => {
  // Seed known ok runs (2×ops.digest = 10m each, 1×estimate.generate = 20m) plus a
  // skipped run. The skipped run counts as an action but must credit 0 minutes;
  // that exact rule is unit-tested — here it simply must not break the render.
  await adminDb.insert(agentRun).values([
    { tenantId, agent: "orchestrator", taskKey: "ops.digest", status: "ok", modelUsed: null },
    { tenantId, agent: "orchestrator", taskKey: "ops.digest", status: "ok", modelUsed: null },
    { tenantId, agent: "orchestrator", taskKey: "estimate.generate", status: "ok", modelUsed: null },
    { tenantId, agent: "comms", taskKey: "lead.rep.alert", status: "skipped", modelUsed: null, error: "quiet-hours" },
  ]);

  // Reduced motion → count-up short-circuits to the final value, so reads are stable.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/today");

  const odometer = page.getByTestId("odometer");
  await expect(odometer).toHaveAttribute("data-mode", "counting");

  const actions = Number((await page.getByTestId("odometer-actions").textContent())?.trim());
  expect(actions).toBeGreaterThanOrEqual(4); // our 4 seeded runs (the skipped one still counts as an action)

  const minutes = Number((await page.getByTestId("odometer-minutes").textContent())?.replace(/[^\d]/g, ""));
  expect(minutes).toBeGreaterThanOrEqual(40); // our 3 ok runs credit ≥ 2×10 + 1×20; the skipped alert adds 0

  // Methodology tooltip cites real, config-derived equivalents. Assert the verb +
  // per-each rate ("· 20m ="), which are invariant to how many estimate runs the
  // shared tenant has — never a count-dependent subtotal.
  const methodology = page.getByTestId("odometer-methodology");
  await expect(methodology).toContainText("How this is counted");
  await expect(methodology).toContainText("· 20m =");
});
