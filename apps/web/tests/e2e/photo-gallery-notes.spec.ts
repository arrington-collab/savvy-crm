/**
 * e2e: the job photo gallery pages through all photos with arrows and autosaves
 * a per-photo note. The image itself won't load in e2e (no real R2), but the
 * gallery chrome — counter, arrows, notes box — renders independently, and the
 * note write is what we assert (persisted to document.notes).
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminDb, customer, property, job, document, eq } from "@savvy/db";

const tenantId = process.env.TEST_TENANT_ID ?? JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")).id;

async function seedJobWithPhotos(stamp: string): Promise<{ jobId: string; firstDocId: string }> {
  const [c] = await adminDb.insert(customer).values({ tenantId, name: `Gallery ${stamp}` }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: `${stamp} Gallery St` }).returning();
  const [jb] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
  const [d1] = await adminDb.insert(document).values({ tenantId, jobId: jb!.id, kind: "photo", label: "north", r2Key: `e2e/${jb!.id}/1.jpg`, filename: "1.jpg", source: "savvy" }).returning();
  await adminDb.insert(document).values({ tenantId, jobId: jb!.id, kind: "photo", label: "south", r2Key: `e2e/${jb!.id}/2.jpg`, filename: "2.jpg", source: "savvy" });
  return { jobId: jb!.id, firstDocId: d1!.id };
}

test("gallery pages through the job's photos and autosaves a note the AI can read", async ({ page }) => {
  const { jobId, firstDocId } = await seedJobWithPhotos(randomUUID().slice(0, 8));

  await page.goto(`/jobs/${jobId}`);
  await expect(page.getByTestId("job-detail")).toBeVisible();
  // Open the Docs tab (custom Tabs — a button by its text).
  await page.locator("#focus-tabs button", { hasText: "Docs" }).click();

  // Open the gallery at the first photo.
  await page.getByTestId(`open-photo-${firstDocId}`).click();
  await expect(page.getByTestId("photo-counter")).toHaveText("1 / 2");
  await expect(page.getByTestId("photo-prev")).toBeDisabled(); // clamped at the start

  // Type a field note — autosaves (debounced).
  await page.getByTestId("photo-note").fill("hail bruising on north slope");
  await expect(page.getByTestId("photo-note-saved")).toBeVisible();

  // Arrow to the next photo.
  await page.getByTestId("photo-next").click();
  await expect(page.getByTestId("photo-counter")).toHaveText("2 / 2");
  await expect(page.getByTestId("photo-next")).toBeDisabled(); // clamped at the end

  // The note persisted to the first photo's document row.
  const [row] = await adminDb.select({ notes: document.notes }).from(document).where(eq(document.id, firstDocId));
  expect(row!.notes).toBe("hail bruising on north slope");
});
