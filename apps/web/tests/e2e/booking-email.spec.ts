/**
 * e2e: the public /book/[token] page captures a homeowner's email at booking
 * time and persists it as self_reported. Public (token-signed) — no auth needed.
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminDb, customer, property, lead, user, eq } from "@savvy/db";
import { signPayloadToken } from "@savvy/core";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };
const SECRET = "dev-unsubscribe-secret"; // confirmSlot's devFallback in non-prod

test("booking captures the homeowner email as self_reported", async ({ page }) => {
  const stamp = randomUUID().slice(0, 8);
  const [rep] = await adminDb.insert(user).values({ tenantId, name: `Rep ${stamp}`, email: "", role: "rep", clerkUserId: null }).returning();
  const [c] = await adminDb.insert(customer).values({ tenantId, name: `Book ${stamp}`, phone: "+16025550000" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: `${stamp} Book St`, lat: 33.4, lng: -111.9 }).returning();
  const [l] = await adminDb.insert(lead).values({ tenantId, customerId: c!.id, propertyId: p!.id, source: "test", assignedUserId: rep!.id }).returning();

  const token = signPayloadToken({ tenantId, leadId: l!.id, type: "inspection" }, SECRET);
  await page.goto(`/book/${token}`);

  const emailAddr = `home-${stamp}@example.com`;
  await page.getByTestId("booking-email").fill(emailAddr);
  // Pick the first available slot.
  await page.locator("button", { hasText: /AM|PM/ }).first().click();
  await expect(page.getByText(/booked/i)).toBeVisible();

  const [row] = await adminDb
    .select({ email: customer.email, emailSource: customer.emailSource })
    .from(customer)
    .where(eq(customer.id, c!.id));
  expect(row!.email).toBe(emailAddr);
  expect(row!.emailSource).toBe("self_reported");
});
