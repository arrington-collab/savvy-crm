import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { adminDb, tenant, customer, property, job, eq } from "@savvy/db";

const { id: tenantId } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string };

// The 2026-07-06 P0 lockout, exercised end-to-end where the harness allows.
//
// NOTE ON SCOPE: TEST_MODE makes the (app) layout bypass its auth block, and the
// onboarding-gate redirect lives inside that block — so a browser cannot observe
// the "/onboarding redirect" itself here (same pre-existing constraint the sibling
// onboarding.spec.ts documents). The redirect DECISION is unit-tested in
// src/lib/onboarding-gate.test.ts (both directions); the DB-level guarantee that
// existing tenants get requiredCompletedAt is covered by the 0059 backfill test and
// the onboarding.no_lockout sweep invariant. What IS fully real here: the skip flow
// (writes the flag + navigates to "/"), and that the (app) routes render for a
// tenant with real work.

let originalSettings: Record<string, unknown>;

test.beforeAll(async () => {
  const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
  originalSettings = (t!.settings as Record<string, unknown>) ?? {};
});

test.afterAll(async () => {
  await adminDb.update(tenant).set({ settings: originalSettings }).where(eq(tenant.id, tenantId));
});

test("skip flow: wizard 'Skip for now' writes requiredCompletedAt and lands on / (not the retired /dashboard)", async ({ page }) => {
  // Put the tenant in the un-onboarded state the wizard is reached from.
  await adminDb
    .update(tenant)
    .set({ settings: { onboarding: { requiredCompletedAt: null, dismissed: false } } })
    .where(eq(tenant.id, tenantId));

  await page.goto("/onboarding");
  await expect(page.getByTestId("onboarding-wizard")).toBeVisible();

  await page.getByTestId("skip-to-dashboard").click();

  // Lands on "/" — NOT /dashboard (retired) and NOT bounced back to /onboarding.
  await expect(page).toHaveURL("http://localhost:3000/");
  await expect(page.getByTestId("onboarding-wizard")).toHaveCount(0);

  // The fix: skip called the lifecycle writer, so the flag is now set.
  await expect(async () => {
    const [t] = await adminDb.select().from(tenant).where(eq(tenant.id, tenantId));
    const ob = (t!.settings as Record<string, unknown>).onboarding as Record<string, unknown> | undefined;
    expect(ob?.requiredCompletedAt).toBeTruthy();
  }).toPass({ timeout: 8000 });
});

test("a tenant with jobs and completed onboarding renders /today and /pipeline (never /onboarding)", async ({ page }) => {
  await adminDb
    .update(tenant)
    .set({ settings: { onboarding: { requiredCompletedAt: new Date().toISOString() } } })
    .where(eq(tenant.id, tenantId));
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "Lockout E2E" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "1 Lockout Ave, Mesa AZ 85203" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id }).returning();

  try {
    await page.goto("/today");
    await expect(page.getByTestId("today-page")).toBeVisible();
    await expect(page).not.toHaveURL(/\/onboarding/);

    await page.goto("/pipeline");
    await expect(page.getByTestId("pipeline-page")).toBeVisible();
    await expect(page).not.toHaveURL(/\/onboarding/);
  } finally {
    await adminDb.delete(job).where(eq(job.id, j!.id));
    await adminDb.delete(property).where(eq(property.id, p!.id));
    await adminDb.delete(customer).where(eq(customer.id, c!.id));
  }
});
