import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { withTenant, adminDb, user, tenant, appointment, lead, eq, and } from "@savvy/db";

const { id: tenantId } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string };

// Booking emits async inngest events; the row appears after the server action returns.
async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 500));
  }
}

test("quick-book: type → rep recommended → slot → book", async ({ page }) => {
  // Seed two reps; a zip territory rule routes 85203 to rep B.
  const reps = await withTenant(tenantId, async (tx) => {
    const a = (await tx.insert(user).values({ tenantId, name: "QB Ann", email: "", role: "rep", clerkUserId: null }).returning({ id: user.id }))[0]!.id;
    const b = (await tx.insert(user).values({ tenantId, name: "QB Bob", email: "", role: "rep", clerkUserId: null }).returning({ id: user.id }))[0]!.id;
    return { a, b };
  });
  await adminDb
    .update(tenant)
    .set({ settings: { assignment: { strategy: "territory", territoryRules: [{ zip: "85203", userId: reps.b }] } } })
    .where(eq(tenant.id, tenantId));

  await page.goto("/leads/quick");
  await expect(page.getByRole("heading", { name: /book it now/i })).toBeVisible();

  await page.getByTestId("qb-name").fill("Dale Homeowner");
  await page.getByTestId("qb-phone").fill("(480) 555-0142");
  // Places is unavailable in TEST_MODE → drive the manual address/city/state/zip fallback.
  // AddressAutocomplete renders with data-testid="address-autocomplete" (ignores the id prop for testid).
  await page.getByTestId("address-autocomplete").fill("882 W Elm St");
  await page.getByTestId("qb-city").fill("Mesa");
  await page.getByTestId("qb-state").fill("AZ");
  await page.getByTestId("qb-zip").fill("85203");

  // Trigger the rep recommendation + slot preview.
  await page.getByTestId("qb-find").click();

  // Rep B (the territory match) is recommended and selected.
  await expect(page.getByTestId("qb-rep")).toHaveValue(reps.b, { timeout: 15_000 });
  await expect(page.getByTestId("qb-recommended")).toBeVisible();

  // At least one slot offered; pick the first and book.
  const slot = page.getByTestId("qb-slot").first();
  await expect(slot).toBeVisible({ timeout: 15_000 });
  await slot.click();
  await page.getByTestId("qb-confirm").click();

  // A scheduled inspection appointment for rep B now exists.
  const appt = await waitFor(async () => {
    const rows = await adminDb
      .select()
      .from(appointment)
      .where(and(eq(appointment.tenantId, tenantId), eq(appointment.assigneeUserId, reps.b)));
    return rows.find((r) => r.status === "scheduled");
  });
  expect(appt.type).toBe("inspection");
  expect(appt.jobId).toBeTruthy();

  // The lead was created with the inbound-call source.
  const created = await waitFor(async () => {
    const rows = await adminDb
      .select({ id: lead.id, source: lead.source, assignedUserId: lead.assignedUserId })
      .from(lead)
      .where(and(eq(lead.tenantId, tenantId), eq(lead.assignedUserId, reps.b)));
    return rows.find((r) => r.source === "inbound-call");
  });
  expect(created.source).toBe("inbound-call");
});
