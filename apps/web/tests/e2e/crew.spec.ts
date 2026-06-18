import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { withTenant, adminDb, customer, property, job, user, crewCheckin, agentRun, eq, and } from "@savvy/db";
import { hashPin } from "@savvy/core";

const { id: tenantId, key } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string; key: string };

test("crew: PIN sign-in -> see job -> check in -> check out", async ({ page }) => {
  const pin = "246810";
  const { jobId, crewUserId } = await withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name: "Crew Carl" }).returning();
    const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: "5 Crew Way" }).returning();
    const [u] = await tx.insert(user).values({ tenantId, name: "Field Fred", email: `fred-${Date.now()}@x.com`, role: "crew" }).returning();
    const [j] = await tx.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production", assignedUserId: u!.id }).returning();
    return { jobId: j!.id, crewUserId: u!.id };
  });
  await adminDb.update(user).set({ pinHash: hashPin(pin) }).where(eq(user.id, crewUserId));

  await page.goto(`/crew/${key}`);
  await expect(page.getByTestId("crew-gate")).toBeVisible();
  await page.getByTestId("crew-pin").fill(pin);
  await page.getByTestId("crew-pin-submit").click();

  await expect(page.locator(`[data-testid="crew-job-row"][data-job-id="${jobId}"]`)).toBeVisible();
  await page.goto(`/crew/${key}/job/${jobId}`);
  await expect(page.getByTestId("crew-job")).toBeVisible();

  await page.getByTestId("crew-checkin-toggle").click();
  await expect(async () => {
    const [row] = await withTenant(tenantId, (tx) => tx.select().from(crewCheckin).where(eq(crewCheckin.jobId, jobId)));
    expect(row).toBeTruthy();
    expect(row?.checkedOutAt ?? null).toBeNull();
  }).toPass({ timeout: 10_000 });

  const runs = await withTenant(tenantId, (tx) =>
    tx.select().from(agentRun).where(and(eq(agentRun.jobId, jobId), eq(agentRun.taskKey, "crew.checkin"))));
  expect(runs.length).toBeGreaterThan(0);

  await page.getByTestId("crew-checkin-toggle").click();
  await expect(async () => {
    const [row] = await withTenant(tenantId, (tx) => tx.select().from(crewCheckin).where(eq(crewCheckin.jobId, jobId)));
    expect(row?.checkedOutAt ?? null).not.toBeNull();
  }).toPass({ timeout: 10_000 });
});
