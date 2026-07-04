import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { adminDb, tenant, eq } from "@savvy/db";

const { id: tenantId } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string };

// TEST_MODE: middleware + (app)/layout bypass auth; getTenantId() → TEST_TENANT_ID.
// The real-auth gate redirect is NOT exercised here (manual-verify only).

test("landing page renders for the public with a sign-up CTA", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /operations layer/i })).toBeVisible();
  await expect(page.getByTestId("landing-signup")).toHaveAttribute("href", "/sign-up");
});

test("wizard: complete welcome step → write lands in DB", async ({ page }) => {
  await page.goto("/onboarding");
  await expect(page.getByTestId("onboarding-wizard")).toBeVisible();
  await page.getByTestId("welcome-company").fill("E2E Roofing Co");
  await page.getByTestId("welcome-continue").click();
  await expect(async () => {
    const [t] = await adminDb.select().from(tenant).where(eq(tenant.id, tenantId));
    const s = t!.settings as Record<string, unknown>;
    const onboarding = s.onboarding as Record<string, unknown> | undefined;
    expect(onboarding?.requiredCompletedAt).toBeTruthy();
    expect(t!.name).toBe("E2E Roofing Co");
  }).toPass({ timeout: 8000 });
});

test("onboarding checklist shows for an incomplete tenant on Today, then dismisses", async ({ page }) => {
  await adminDb.update(tenant)
    .set({ revenueBand: null, settings: { onboarding: { requiredCompletedAt: "x", dismissed: false } } })
    .where(eq(tenant.id, tenantId));
  await page.goto("/today");
  await expect(page.getByTestId("onboarding-checklist")).toBeVisible();
  await page.getByTestId("checklist-dismiss").click();
  await expect(async () => {
    const [t] = await adminDb.select().from(tenant).where(eq(tenant.id, tenantId));
    const s2 = t!.settings as Record<string, unknown>;
    const ob2 = s2.onboarding as Record<string, unknown>;
    expect(ob2.dismissed).toBe(true);
  }).toPass({ timeout: 8000 });
});
