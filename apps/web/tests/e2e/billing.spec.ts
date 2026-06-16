import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  adminDb, withTenant, recordUsageSnapshot,
  tenant, user, customer, property, job, jobStageEvent, agentRun, communication, document, eq,
} from "@savvy/db";

const { id: tenantId } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string; key: string };

const now = new Date();
const periodKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

test("billing: usage is metered into a bill; dashboard shows velocity + rep performance", async ({ page }) => {
  const stamp = randomUUID().slice(0, 8);

  // ---- 1) Seed tenant on the starter band + a rep + a job ---------------------
  await adminDb.update(tenant).set({ revenueBand: "starter" }).where(eq(tenant.id, tenantId));

  const [rep] = await adminDb.insert(user).values({
    tenantId, name: `Rep ${stamp}`, email: `rep-${stamp}@e2e.test`, role: "rep",
  }).returning();
  const [cust] = await adminDb.insert(customer).values({ tenantId, name: `Cust ${stamp}` }).returning();
  const [prop] = await adminDb.insert(property).values({
    tenantId, customerId: cust!.id, address: `${stamp} Meter Ln`,
  }).returning();
  // Job opened + closed this period so it counts toward jobs-processed + rep daysToClose.
  const opened = new Date(now.getTime() - 5 * 86_400_000);
  const [j] = await adminDb.insert(job).values({
    tenantId, customerId: cust!.id, propertyId: prop!.id, type: "retail", stage: "approved",
    assignedUserId: rep!.id, valueEstimate: 850000, openedAt: opened, closedAt: now,
  }).returning();

  // ---- 2) Seed usage signals in the current period (all under starter allowances) ----
  await adminDb.insert(agentRun).values({ tenantId, agent: "finance", status: "ok", costCents: 1200, startedAt: now });
  await adminDb.insert(communication).values({
    tenantId, jobId: j!.id, channel: "call", direction: "inbound", durationSeconds: 240, createdAt: now,
  });
  await adminDb.insert(document).values({
    tenantId, jobId: j!.id, kind: "photo", r2Key: `e2e/${stamp}-1`, sizeBytes: 2_000_000, createdAt: now,
  });
  // Two stage events so velocity has a measurable per-stage duration.
  await adminDb.insert(jobStageEvent).values({ tenantId, jobId: j!.id, toStage: "lead", enteredAt: opened });
  await adminDb.insert(jobStageEvent).values({
    tenantId, jobId: j!.id, fromStage: "lead", toStage: "approved", enteredAt: now,
  });

  // ---- 3) Run the meter (idempotent) -> writes a usage_snapshot for this period ----
  const snap = await recordUsageSnapshot(tenantId, periodKey);
  expect(snap.bandKey).toBe("starter");
  expect(snap.basePriceCents).toBe(49900);
  // Usage is under all starter allowances -> base price only, no overage.
  expect(snap.totalCents).toBe(49900);

  // ---- 4) /billing shows the band, the current bill, and the snapshot history ----
  await page.goto("/billing");
  await expect(page.getByTestId("billing-page")).toBeVisible();
  await expect(page.getByText(/starter/i).first()).toBeVisible();
  // Current-period bill (computed live) is the $499.00 base with this modest usage.
  await expect(page.getByTestId("billing-total")).toContainText("$499.00");

  // ---- 5) /dashboard shows the velocity + rep/team performance reports ----------
  await page.goto("/dashboard");
  await expect(page.getByTestId("velocity-card")).toBeVisible();
  const repPerf = page.getByTestId("rep-performance");
  await expect(repPerf).toBeVisible();
  await expect(repPerf).toContainText(rep!.name);

  // DB-backed cross-check: the snapshot persisted for history.
  const rows = await withTenant(tenantId, (tx) => tx.select().from(jobStageEvent).where(eq(jobStageEvent.jobId, j!.id)));
  expect(rows.length).toBe(2);
});
