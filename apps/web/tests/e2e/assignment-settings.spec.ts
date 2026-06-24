import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { withTenant, user } from "@savvy/db";

const { id: tenantId } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string };

test.beforeAll(async () => {
  await withTenant(tenantId, async (tx) => {
    await tx
      .insert(user)
      .values({ tenantId, name: "Assign Rep One", email: `ar1-${Date.now()}@x.com`, role: "rep" });
  });
});

test("manager sets least-loaded strategy and it persists", async ({ page }) => {
  await page.goto("/settings/assignment");
  await expect(page.getByTestId("assignment-settings")).toBeVisible();
  await page.getByTestId("assignment-strategy").selectOption("least_loaded");
  await page.getByTestId("save-assignment").click();
  await expect(page.getByText("Saved")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("assignment-strategy")).toHaveValue("least_loaded");
});

test("switching to territory reveals the rule editor", async ({ page }) => {
  await page.goto("/settings/assignment");
  await page.getByTestId("assignment-strategy").selectOption("territory");
  await expect(page.getByTestId("territory-editor")).toBeVisible();
  await page.getByTestId("add-territory").click();
  await expect(page.getByTestId("territory-rep-0")).toBeVisible();
});
