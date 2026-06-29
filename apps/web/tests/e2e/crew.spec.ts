import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { withTenant, adminDb, customer, property, job, user, crewCheckin, agentRun, eq, and } from "@savvy/db";
import { crew, crewMember, appointment } from "@savvy/db";
import { hashPin } from "@savvy/core";

const { id: tenantId, key } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string; key: string };

test("crew: PIN sign-in -> see job -> check in -> check out", async ({ page }) => {
  const pin = "246810";
  const { jobId, crewUserId } = await withTenant(tenantId, async (tx) => {
    const [c] = await tx.insert(customer).values({ tenantId, name: "Crew Carl" }).returning();
    const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: "5 Crew Way" }).returning();
    const [u] = await tx.insert(user).values({ tenantId, name: "Field Fred", email: `fred-${Date.now()}@x.com`, role: "crew" }).returning();
    const [j] = await tx.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production", assignedUserId: u!.id }).returning();
    return { jobId: j!.id, crewUserId: u!.id };
  });
  await adminDb.update(user).set({ pinHash: hashPin(pin) }).where(eq(user.id, crewUserId));

  await page.goto(`/crew/${key}`);
  await expect(page.getByTestId("crew-gate")).toBeVisible();
  await page.getByTestId("crew-pin").fill(pin);
  await page.getByTestId("crew-pin-submit").click();

  await expect(page.locator(`[data-testid="crew-job-row"][data-job-id="${jobId}"]`)).toBeVisible();
  await page.goto(`/crew/${key}/job/${jobId}`);
  await expect(page.getByTestId("crew-job")).toBeVisible();

  await page.getByTestId("crew-checkin-toggle").click();
  await expect(async () => {
    const [row] = await withTenant(tenantId, (tx) => tx.select().from(crewCheckin).where(eq(crewCheckin.jobId, jobId)));
    expect(row).toBeTruthy();
    expect(row?.checkedOutAt ?? null).toBeNull();
  }).toPass({ timeout: 10_000 });

  const runs = await withTenant(tenantId, (tx) =>
    tx.select().from(agentRun).where(and(eq(agentRun.jobId, jobId), eq(agentRun.taskKey, "crew.checkin"))));
  expect(runs.length).toBeGreaterThan(0);

  await page.getByTestId("crew-checkin-toggle").click();
  await expect(async () => {
    const [row] = await withTenant(tenantId, (tx) => tx.select().from(crewCheckin).where(eq(crewCheckin.jobId, jobId)));
    expect(row?.checkedOutAt ?? null).not.toBeNull();
  }).toPass({ timeout: 10_000 });
});

test("shared crew PIN → tap name → check in attributed to the picked member", async ({ page }) => {
  const sharedPin = "864209";
  const stamp = Date.now();

  const { jobId, member1Id } = await withTenant(tenantId, async (tx) => {
    // Two crew users with unique stamped names
    const [u1] = await tx.insert(user).values({
      tenantId,
      name: `Shared Alpha ${stamp}`,
      email: `shared-alpha-${stamp}@x.com`,
      role: "crew",
    }).returning();
    const [u2] = await tx.insert(user).values({
      tenantId,
      name: `Shared Beta ${stamp}`,
      email: `shared-beta-${stamp}@x.com`,
      role: "crew",
    }).returning();

    // Crew with shared PIN hash
    const [cr] = await tx.insert(crew).values({
      tenantId,
      name: `Shared Crew ${stamp}`,
      active: true,
      pinHash: hashPin(sharedPin),
    }).returning();

    // Both users as crew members
    await tx.insert(crewMember).values({ tenantId, crewId: cr!.id, userId: u1!.id });
    await tx.insert(crewMember).values({ tenantId, crewId: cr!.id, userId: u2!.id });

    // A job in production stage
    const [c] = await tx.insert(customer).values({ tenantId, name: `Shared Customer ${stamp}` }).returning();
    const [p] = await tx.insert(property).values({ tenantId, customerId: c!.id, address: `${stamp} Shared Ave` }).returning();
    const [j] = await tx.insert(job).values({
      tenantId,
      customerId: c!.id,
      propertyId: p!.id,
      type: "retail",
      stage: "production",
    }).returning();

    // A crew-type appointment linking the job to the crew entity
    const now = new Date();
    const later = new Date(now.getTime() + 4 * 60 * 60 * 1000); // +4h
    await tx.insert(appointment).values({
      tenantId,
      jobId: j!.id,
      customerId: c!.id,
      type: "crew",
      crewId: cr!.id,
      startsAt: now,
      endsAt: later,
    });

    return { jobId: j!.id, member1Id: u1!.id, _member2Id: u2!.id };
  });

  // Navigate to the crew gate
  await page.goto(`/crew/${key}`);
  await expect(page.getByTestId("crew-gate")).toBeVisible();

  // Enter shared crew PIN
  await page.getByTestId("crew-pin").fill(sharedPin);
  await page.getByTestId("crew-pin-submit").click();

  // Step 2: member picker should appear
  await expect(page.getByTestId("crew-member-pick")).toBeVisible();

  // Tap the first member's button
  await page.locator(`[data-testid="crew-member-option"][data-user-id="${member1Id}"]`).click();

  // Should land on the crew dashboard and see the seeded job
  await expect(page.locator(`[data-testid="crew-job-row"][data-job-id="${jobId}"]`)).toBeVisible();

  // Navigate to the job and check in
  await page.goto(`/crew/${key}/job/${jobId}`);
  await expect(page.getByTestId("crew-job")).toBeVisible();

  await page.getByTestId("crew-checkin-toggle").click();

  // Verify check-in row is attributed to member1
  await expect(async () => {
    const [row] = await withTenant(tenantId, (tx) =>
      tx.select().from(crewCheckin).where(and(eq(crewCheckin.jobId, jobId), eq(crewCheckin.crewUserId, member1Id))));
    expect(row).toBeTruthy();
    expect(row?.checkedOutAt ?? null).toBeNull();
  }).toPass({ timeout: 10_000 });
});
