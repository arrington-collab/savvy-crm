/**
 * e2e: weather-at-risk crew appointments surface in /exceptions (D1b).
 * Seeds a future crew appt with weather_flagged_at + weather_note set (as the
 * cron would), asserts the /exceptions "Weather risk" row. Scoped to a stamped
 * customer name (the page aggregates ALL tenant rows).
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminDb, customer, property, job, appointment } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

test("a weather-flagged crew appt appears as a Weather risk exception", async ({ page }) => {
  const stamp = randomUUID().slice(0, 8);
  const name = `Rain Ray ${stamp}`;
  const [c] = await adminDb.insert(customer).values({ tenantId, name, email: `rain-${stamp}@e2e.test` }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: `${stamp} Rain Rd`, lat: 33.4, lng: -112.0, roofType: "asphalt_shingle" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
  const startsAt = new Date(Date.now() + 2 * 86_400_000);
  await adminDb.insert(appointment).values({
    tenantId, jobId: j!.id, customerId: c!.id, type: "crew", status: "scheduled",
    startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000),
    weatherNote: "Rain 90%", weatherFlaggedAt: new Date(),
  });

  await page.goto("/today");
  await expect(page.getByTestId("today-page")).toBeVisible();
  const row = page.locator('[data-testid="decision-card"]', { hasText: name });
  await expect(row).toContainText("Weather risk");
  await expect(row).toContainText("Rain 90% — reschedule");
  await expect(row).toHaveAttribute("data-severity", "medium");
});
