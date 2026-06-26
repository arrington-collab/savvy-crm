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
