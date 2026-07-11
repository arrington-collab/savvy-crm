import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { withTenant, customer, property, lead } from "@savvy/db";

const { id: tenantId } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string };

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

// Slice 4: the lead tile is reorganized to field-working order. Sections carry a
// stable data-section attribute so the order is a contract, not incidental markup.
const EXPECTED_SECTION_ORDER = [
  "contact",
  "score",
  "roof",
  "measurement",
  "estimate",
  "documents",
  "source",
  "comms",
];

test("lead tile: sections render in field-working order", async ({ page }) => {
  const id = await seedLead("Ordered Olive", "new", 72);
  await page.goto(`/leads/${id}`);
  await expect(page.getByTestId("lead-detail")).toBeVisible();

  const order = await page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-section]")).map(
      (el) => (el as HTMLElement).dataset.section,
    ),
  );
  expect(order).toEqual(EXPECTED_SECTION_ORDER);
});

test("lead tile: Back to Leads preserves the list filter", async ({ page }) => {
  const contactedId = await seedLead("Back Bertha", "contacted", 61);

  // Open the filtered list, then the lead FROM that list (row carries ?from).
  await page.goto("/leads?status=contacted&sort=age");
  const row = page.locator(`[data-testid="lead-row"][data-lead-id="${contactedId}"]`);
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByTestId("lead-detail")).toBeVisible();

  // The prominent Back button returns to the SAME filtered view.
  await page.getByTestId("back-to-leads").click();
  await expect(page).toHaveURL(/\/leads\?status=contacted&sort=age/);
  await expect(page.locator(`[data-testid="lead-row"][data-lead-id="${contactedId}"]`)).toBeVisible();
});

test("lead tile: Back to Leads restores list scroll position", async ({ page }) => {
  // Enough rows to make the list scroll.
  for (let i = 0; i < 30; i++) await seedLead(`Scroll ${String(i).padStart(2, "0")}`, "new", 50 + (i % 40));

  await page.goto("/leads");
  await expect(page.getByTestId("funnel")).toBeVisible();
  // Scroll capture attaches after hydration — wait for its readiness marker so the
  // row click is captured (the row's ?from href works without JS, but scroll doesn't).
  await page.waitForSelector("html[data-leads-scroll-ready]");
  // Scroll the list down, then open a row that is ALREADY visible at this offset —
  // clicking a far row would make Playwright auto-scroll to it first, changing the
  // captured position. This mirrors a rep scrolling then tapping a card in view.
  await page.evaluate(() => window.scrollTo(0, 600));
  await page.waitForFunction(() => window.scrollY >= 500);
  const visibleId = await page.evaluate(() => {
    for (const r of Array.from(document.querySelectorAll('[data-testid="lead-row"]'))) {
      const b = (r as HTMLElement).getBoundingClientRect();
      if (b.top >= 8 && b.bottom <= window.innerHeight - 8) return r.getAttribute("data-lead-id");
    }
    return null;
  });
  expect(visibleId).toBeTruthy();
  await page.locator(`[data-testid="lead-row"][data-lead-id="${visibleId}"]`).click();
  await expect(page.getByTestId("lead-detail")).toBeVisible();

  // The list persisted its scroll position at navigate-away time.
  expect(await page.evaluate(() => Number(sessionStorage.getItem("leads:list:scrollY")))).toBeGreaterThan(300);

  await page.getByTestId("back-to-leads").click();
  await expect(page.getByTestId("funnel")).toBeVisible();
  await page.waitForSelector("html[data-leads-scroll-ready]");
  // Scroll is restored (allow a little tolerance for layout/rounding). Bounded to the
  // component's ~3s restore budget plus hydration slack.
  await page.waitForFunction(() => window.scrollY > 300, undefined, { timeout: 8000 });
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(300);
});
