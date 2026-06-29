/**
 * e2e: public homeowner status page (F). Seeds a job + stage events + a future
 * crew appt, signs a status token (UNSUBSCRIBE_SECRET, dev fallback in TEST_MODE),
 * and asserts /status/<token> renders the journey + next appointment. An invalid
 * token shows the friendly error.
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminDb, customer, property, job, jobStageEvent, appointment } from "@savvy/db";
import { signPayloadToken } from "@savvy/core";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };
const SECRET = process.env.UNSUBSCRIBE_SECRET ?? "dev-unsubscribe-secret";

test("homeowner status page renders the journey + next appointment", async ({ page }) => {
  const stamp = randomUUID().slice(0, 8);
  const [c] = await adminDb.insert(customer).values({ tenantId, name: `Homer ${stamp}`, email: `homer-${stamp}@e2e.test` }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: `${stamp} Roof Ln` }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
  await adminDb.insert(jobStageEvent).values({ tenantId, jobId: j!.id, toStage: "approved", enteredAt: new Date(Date.now() - 86_400_000) });
  await adminDb.insert(jobStageEvent).values({ tenantId, jobId: j!.id, toStage: "production", enteredAt: new Date() });
  const future = new Date(Date.now() + 2 * 86_400_000);
  await adminDb.insert(appointment).values({ tenantId, jobId: j!.id, customerId: c!.id, type: "crew", status: "scheduled", startsAt: future, endsAt: new Date(future.getTime() + 3_600_000) });

  const token = signPayloadToken({ tenantId, jobId: j!.id }, SECRET);
  await page.goto(`/status/${token}`);
  await expect(page.getByTestId("status-page")).toBeVisible();
  await expect(page.getByTestId("status-headline")).toContainText("Installation underway");
  await expect(page.getByTestId("status-next-appt")).toContainText("crew");
  await expect(page.getByTestId("milestone-production")).toHaveAttribute("data-status", "current");
  await expect(page.getByTestId("milestone-approved")).toHaveAttribute("data-status", "done");
  await expect(page.getByTestId("milestone-complete")).toHaveAttribute("data-status", "upcoming");

  await page.goto("/status/garbage.token");
  await expect(page.getByTestId("status-invalid")).toBeVisible();
});
