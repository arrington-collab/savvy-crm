import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { withTenant, customer, property, lead, user, eq } from "@savvy/db";

const { id: tenantId } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string };

// Direct DB seed: does NOT emit lead/created, so seeded leads keep their status
// (a form-created lead would be auto-qualified new -> contacted by the agent).
async function seedLead(name: string, status: "new" | "contacted", score: number) {
  return withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name, phone: "+15555550000" }).returning();
    const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: `${name} St` }).returning();
    const [l] = await tx
      .insert(lead)
      .values({ tenantId, customerId: c!.id, propertyId: p!.id, status, score, source: "seed" })
      .returning();
    return l!.id;
  });
}

test("leads: list, filter, detail, convert, mark lost", async ({ page }) => {
  const newId = await seedLead("Funnel New", "new", 80);
  const contactedId = await seedLead("Funnel Contacted", "contacted", 60);

  // List shows both rows; funnel strip renders.
  await page.goto("/leads");
  await expect(page.getByTestId("funnel")).toBeVisible();
  await expect(page.locator(`[data-testid="lead-row"][data-lead-id="${newId}"]`)).toBeVisible();
  await expect(page.locator(`[data-testid="lead-row"][data-lead-id="${contactedId}"]`)).toBeVisible();

  // Filter to contacted: the 'new' lead drops out.
  await page.goto("/leads?status=contacted");
  await expect(page.locator(`[data-testid="lead-row"][data-lead-id="${contactedId}"]`)).toBeVisible();
  await expect(page.locator(`[data-testid="lead-row"][data-lead-id="${newId}"]`)).toHaveCount(0);

  // Detail of the 'new' lead shows its score.
  await page.goto(`/leads/${newId}`);
  await expect(page.getByTestId("lead-detail")).toBeVisible();
  await expect(page.getByTestId("lead-score")).toContainText("80");

  // Convert -> redirected to the job; lead becomes 'booked'.
  await page.getByTestId("convert-lead").click();
  await page.waitForURL(/\/jobs\/.+/);
  const [converted] = await withTenant(tenantId, (tx) => tx.select().from(lead).where(eq(lead.id, newId)));
  expect(converted!.status).toBe("booked");

  // Re-open: Convert is gone (booked), Assign remains.
  await page.goto(`/leads/${newId}`);
  await expect(page.getByTestId("convert-lead")).toHaveCount(0);
  await expect(page.getByTestId("assign-owner")).toBeVisible();

  // Mark the contacted lead lost -> read-only.
  await page.goto(`/leads/${contactedId}`);
  await page.getByTestId("mark-lost").click();
  await expect(page.getByTestId("lead-actions-readonly")).toBeVisible();
  const [lost] = await withTenant(tenantId, (tx) => tx.select().from(lead).where(eq(lead.id, contactedId)));
  expect(lost!.status).toBe("lost");
});

test("leads: create via form + assign owner", async ({ page }) => {
  // Seed a tenant user so the assign dropdown has an option.
  const userId = await withTenant(tenantId, async (tx) => {
    const [u] = await tx
      .insert(user)
      .values({ tenantId, name: "Rep Robin", email: `robin-${Date.now()}@x.com` })
      .returning();
    return u!.id;
  });

  // Create through the form.
  await page.goto("/leads/new");
  await page.fill('input[name="name"]', "Formed Fiona");
  await page.fill('input[name="phone"]', "+15555551212");
  await page.fill('input[name="address"]', "12 Form Ave");
  await page.getByTestId("new-lead-submit").click();
  await page.waitForURL(/\/leads\/[0-9a-f-]+$/);
  await expect(page.getByTestId("lead-detail")).toBeVisible();

  // Assign the seeded user; owner cell reflects it after refresh.
  await page.getByTestId("assign-owner").selectOption(userId);
  await expect(page.getByTestId("lead-owner")).toContainText("Rep Robin");
});
