import { test, expect } from "@playwright/test";

// Guards the Turbopack compile of /settings/profile (the .js-import CI failure
// class) and that the self-service phone field renders. Persistence isn't
// asserted here: TEST_MODE getCurrentUser() returns a synthetic user with no
// db row, so saveMyPhone() is a no-op. The admin phone path is covered (with a
// real DB assertion) in team.spec.ts.
test("profile: self-service phone field renders", async ({ page }) => {
  await page.goto("/settings/profile");
  await expect(page.getByRole("heading", { name: "Your profile" })).toBeVisible();
  await expect(page.getByTestId("profile-phone")).toBeVisible();
  await expect(page.getByTestId("profile-phone-save")).toBeVisible();
});

// Block-time CRUD is asserted at the DB layer (availability.test.ts: create/list/delete +
// ownership + RLS). TEST_MODE's synthetic user can't persist via the UI, so here we only
// guard the section's Turbopack compile + that the controls render.
test("profile: block-time section renders", async ({ page }) => {
  await page.goto("/settings/profile");
  await expect(page.getByTestId("block-start")).toBeVisible();
  await expect(page.getByTestId("block-end")).toBeVisible();
  await expect(page.getByTestId("block-add")).toBeVisible();
});
