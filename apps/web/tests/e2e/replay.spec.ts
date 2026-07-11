import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { withTenant, customer, property, lead, agentRun } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

// A fixed far-past day (Phoenix, UTC-7 year-round) so no other test's runs land here.
const DAY = "2020-03-15";
const at = (h: number) => new Date(`2020-03-15T${String(h).padStart(2, "0")}:00:00Z`); // within [07:00Z, next 07:00Z)

test("replay of a past day reveals that day's runs with names", async ({ page }) => {
  // Reduced motion → the replay reveals the whole day statically (no 90s wait, deterministic).
  await page.emulateMedia({ reducedMotion: "reduce" });
  await withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name: "Replay Ellie" }).returning();
    const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: "1 Replay Rd, Mesa AZ" }).returning();
    const [l] = await tx.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, status: "new", source: "seed" }).returning();
    await tx.insert(agentRun).values([
      { tenantId, agent: "comms", taskKey: "lead.qualify", status: "ok", leadId: l!.id, startedAt: at(12), finishedAt: at(12) },
      { tenantId, agent: "scheduling", taskKey: "appt.remind", status: "ok", leadId: l!.id, startedAt: at(16), finishedAt: at(16) },
      { tenantId, agent: "finance", taskKey: "invoice.stage", status: "skipped", leadId: l!.id, startedAt: at(20), finishedAt: at(20) },
    ]);
  });

  await page.goto(`/activity?replay=${DAY}`);
  await expect(page.getByRole("heading", { name: `Replay · ${DAY}` })).toBeVisible();
  await expect(page.getByTestId("replay-view")).toBeVisible();
  // Full reveal under reduced motion — all three runs, with the customer name shown.
  await expect(page.getByTestId("activity-row")).toHaveCount(3);
  await expect(page.getByTestId("replay-view")).toContainText("Replay Ellie");
  await expect(page.getByTestId("replay-scrubber")).toBeVisible();
});

test("an empty day says nothing to replay", async ({ page }) => {
  await page.goto("/activity?replay=2019-01-01");
  await expect(page.getByTestId("replay-empty")).toContainText(/nothing to replay/i);
});
