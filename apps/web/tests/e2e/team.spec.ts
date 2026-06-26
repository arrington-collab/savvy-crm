import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { withTenant, user, eq, and, isNull } from "@savvy/db";

const { id: tenantId } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string };

// TEST_MODE: isOrgAdmin() returns true, so the team page + actions are reachable.
// Only app-only paths (add crew, change crew role, remove crew) are exercised — the
// Clerk-backed invite/role/remove paths need a Clerk instance (manual checklist).

test("team: add crew member, change role, remove → deactivated", async ({ page }) => {
  const crewName = `E2E Cody ${Date.now()}`;

  await page.goto("/settings/team");
  await expect(page.getByRole("heading", { name: "Team" })).toBeVisible();

  await page.getByPlaceholder("Crew member name").fill(crewName);
  await page.getByTestId("add-crew-submit").click();
  const row = page.locator('[data-testid="team-row"]', { hasText: crewName });
  await expect(row).toBeVisible();

  const u = await withTenant(tenantId, (tx) =>
    tx.select({ id: user.id }).from(user).where(and(eq(user.name, crewName), isNull(user.deactivatedAt))));
  expect(u.length).toBe(1);
  const userId = u[0]!.id;

  await row.getByTestId("role-select").selectOption("office");
  await expect(async () => {
    const [r] = await withTenant(tenantId, (tx) => tx.select().from(user).where(eq(user.id, userId)));
    expect(r?.role).toBe("office");
  }).toPass({ timeout: 8000 });

  // Admin sets the member's mobile (for rep speed-to-lead alerts) → normalized to E.164.
  await row.getByTestId("member-phone").fill("(480) 555-0142");
  await row.getByTestId("member-phone").blur();
  await expect(async () => {
    const [r] = await withTenant(tenantId, (tx) => tx.select().from(user).where(eq(user.id, userId)));
    expect(r?.phone).toBe("+14805550142");
  }).toPass({ timeout: 8000 });

  await row.getByTestId("remove-member").click();
  await expect(async () => {
    const [r] = await withTenant(tenantId, (tx) => tx.select().from(user).where(eq(user.id, userId)));
    expect(r?.deactivatedAt ?? null).not.toBeNull();
  }).toPass({ timeout: 8000 });
});
