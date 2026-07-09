/**
 * e2e: completion-photo gate + required-photo checklist
 *
 * Under the contiguous evidence model the completion-photo requirement is the
 * `closeoutPhotos` rung — it gates entry into the `closeout` stage. A job that
 * lacks the before/after photos can't advance into closeout, and the generic
 * evidence gate reports "completion photos" as the missing rung.
 *
 * Strategy:
 *  - DB-layer gate: seed the contiguous chain up through `production`, then
 *    call recordStageChange(->closeout) directly (via adminDb + withTenant) to
 *    prove StageEvidenceError is thrown while the completion photos are absent,
 *    and that the gate passes once before/after photos are seeded.
 *  - UI checklist: navigate to /jobs/{id} → Docs tab and assert the
 *    `data-testid="required-photo-{label}"` items show ✗ (missing) before
 *    photos are seeded and ✓ (present) after.
 *
 * Photos are seeded via adminDb — NOT through the real upload UI, which
 * requires R2 env vars that are not available in the local test harness.
 */

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  adminDb,
  withTenant,
  customer,
  property,
  job,
  document,
  estimate,
  appointment,
  recordStageChange,
  StageEvidenceError,
  eq,
} from "@savvy/db";

const { id: tenantId } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string; key: string };

// ── helpers ─────────────────────────────────────────────────────────────────

/** Seed a minimal retail job with no photos and return its id. */
async function seedRetailJob(stamp: string): Promise<string> {
  const [c] = await adminDb
    .insert(customer)
    .values({ tenantId, name: `Gating Gary ${stamp}`, phone: "+15555560001" })
    .returning();
  const [p] = await adminDb
    .insert(property)
    .values({ tenantId, customerId: c!.id, address: `${stamp} Gate St` })
    .returning();
  const [j] = await adminDb
    .insert(job)
    .values({
      tenantId,
      customerId: c!.id,
      propertyId: p!.id,
      type: "retail",
      stage: "production", // close to complete so the gate is the only blocker
    })
    .returning();
  return j!.id;
}

/** Insert a photo document record for a job (bypasses R2 — just the DB row). */
async function seedPhoto(jobId: string, label: string): Promise<void> {
  await adminDb.insert(document).values({
    tenantId,
    jobId,
    kind: "photo",
    label,
    r2Key: `e2e/${jobId}/${label}.jpg`,
    filename: `${label}.jpg`,
    mime: "image/jpeg",
  });
}

/**
 * Seed the contiguous evidence chain up through `production` (inspection,
 * estimate, approval, production) but NOT the before/after completion photos —
 * so `closeoutPhotos` is the only unmet rung and the evidence gate blocks the
 * move into closeout with "completion photos". The inspection photo carries a
 * non-checklist label so it does not accidentally satisfy the completion gate.
 */
async function seedProductionEvidence(jobId: string): Promise<void> {
  await adminDb.insert(document).values({
    tenantId,
    jobId,
    kind: "photo",
    label: "inspection",
    r2Key: `e2e/${jobId}/inspection.jpg`,
    filename: "inspection.jpg",
    mime: "image/jpeg",
  });
  await adminDb.insert(estimate).values({ tenantId, jobId, lineItems: [], status: "accepted" });
  await adminDb.insert(appointment).values({
    tenantId,
    jobId,
    type: "crew",
    status: "scheduled",
    startsAt: new Date(Date.now() + 7 * 86_400_000),
    endsAt: new Date(Date.now() + 7 * 86_400_000 + 3_600_000),
  });
}

/** Read the current stage of a job directly from the DB (admin client, bypasses RLS). */
async function getJobStage(jobId: string): Promise<string | null> {
  const [row] = await adminDb
    .select({ stage: job.stage })
    .from(job)
    .where(eq(job.id, jobId));
  return row?.stage ?? null;
}

// ── tests ────────────────────────────────────────────────────────────────────

test.describe("completion-photo gate", () => {
  test("gate blocks closeout when completion photos are missing, then allows it after before/after photos are seeded", async () => {
    const stamp = Date.now().toString(36);
    const jobId = await seedRetailJob(stamp);
    // full chain through production, minus the before/after completion photos
    await seedProductionEvidence(jobId);

    // ── 1) Evidence gate rejects the closeout move: completion photos absent ─
    let gateError: unknown;
    try {
      await withTenant(tenantId, (tx) =>
        recordStageChange(tx, { tenantId, jobId, toStage: "closeout" }),
      );
    } catch (e) {
      gateError = e;
    }
    expect(gateError).toBeInstanceOf(StageEvidenceError);
    expect((gateError as StageEvidenceError).missing).toBe("completion photos");

    // DB confirms the job did NOT advance out of production
    expect(await getJobStage(jobId)).toBe("production");

    // ── 2) Seed the two required completion photos via adminDb ────────────
    await seedPhoto(jobId, "before");
    await seedPhoto(jobId, "after");

    // ── 3) Gate now allows the closeout move ──────────────────────────────
    const result = await withTenant(tenantId, (tx) =>
      recordStageChange(tx, { tenantId, jobId, toStage: "closeout" }),
    );
    expect(result).toMatchObject({ activated: expect.any(Number) });

    // DB confirms the job reached closeout
    expect(await getJobStage(jobId)).toBe("closeout");
  });
});

test.describe("required-photo checklist UI", () => {
  test("checklist shows missing (✗) before photos and present (✓) after", async ({ page }) => {
    const stamp = Date.now().toString(36) + "ui";
    const jobId = await seedRetailJob(stamp);

    // ── 1) Navigate to job detail, open Docs tab ─────────────────────────
    await page.goto(`/jobs/${jobId}`);
    await expect(page.getByTestId("job-detail")).toBeVisible();

    // Click the Docs tab to reveal the DocsPanel.
    // TabsTrigger renders as a plain <button>, not role="tab", so use getByRole("button").
    await page.getByRole("button", { name: "Docs" }).click();

    // ── 2) Both required photos show as missing ───────────────────────────
    const beforeItem = page.getByTestId("required-photo-before");
    const afterItem = page.getByTestId("required-photo-after");

    await expect(beforeItem).toBeVisible();
    await expect(afterItem).toBeVisible();

    // aria-label carries "uploaded" or "missing"; check for "missing" state
    await expect(beforeItem).toHaveAttribute("aria-label", /missing/i);
    await expect(afterItem).toHaveAttribute("aria-label", /missing/i);

    // The ✗ symbol is in the item text
    await expect(beforeItem).toContainText("✗");
    await expect(afterItem).toContainText("✗");

    // ── 3) Seed both photos via adminDb then reload ───────────────────────
    await seedPhoto(jobId, "before");
    await seedPhoto(jobId, "after");

    await page.reload();
    await page.getByRole("button", { name: "Docs" }).click();

    // ── 4) Both required photos now show as present ───────────────────────
    await expect(page.getByTestId("required-photo-before")).toHaveAttribute(
      "aria-label",
      /uploaded/i,
    );
    await expect(page.getByTestId("required-photo-after")).toHaveAttribute(
      "aria-label",
      /uploaded/i,
    );

    await expect(page.getByTestId("required-photo-before")).toContainText("✓");
    await expect(page.getByTestId("required-photo-after")).toContainText("✓");
  });
});
