/**
 * e2e: Phase 6B closeout e-sign — send → webhook → completed.
 *
 * Strategy:
 *  - Seed a job + customer (WITH email) via adminDb, like production-gating.spec.ts.
 *  - Drive the UI: open the E-sign tab, click "Send for signature". The send action
 *    calls the DocuSeal stub (configured via playwright.config webServer env), so a
 *    `sent` request with a copy-link appears.
 *  - Capture the real DocuSeal submission id from the esign_request row, then POST a
 *    simulated webhook to the public route. With an empty DOCUSEAL_WEBHOOK_SECRET the
 *    gateway skips HMAC, so the plain body is accepted.
 *  - Assert the request flips to "Completed".
 *
 * The signed-PDF finalize (R2 storage via esignFinalize) is intentionally NOT asserted
 * here — the harness has no R2 creds and markEsignBySubmission flips status to completed
 * BEFORE the event is emitted. Finalize/storage is covered by the agents integration test.
 */

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { adminDb, customer, property, job, esignRequest, eq } from "@savvy/db";

const { id: tenantId } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string; key: string };

/** Seed a job whose customer has an email (required to send for signature). */
async function seedJobWithEmail(stamp: string): Promise<string> {
  const [c] = await adminDb
    .insert(customer)
    .values({ tenantId, name: `Esign Ed ${stamp}`, email: `ed-${stamp}@example.com`, phone: "+15555570001" })
    .returning();
  const [p] = await adminDb
    .insert(property)
    .values({ tenantId, customerId: c!.id, address: `${stamp} Sign St` })
    .returning();
  const [j] = await adminDb
    .insert(job)
    .values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" })
    .returning();
  return j!.id;
}

test("send for signature, then webhook marks it completed", async ({ page, request }) => {
  const stamp = Date.now().toString(36);
  const jobId = await seedJobWithEmail(stamp);

  // ── open the E-sign tab ────────────────────────────────────────────────────
  await page.goto(`/jobs/${jobId}`);
  await expect(page.getByTestId("job-detail")).toBeVisible();
  // TabsTrigger renders a plain <button>, not role="tab".
  await page.getByRole("button", { name: "E-sign" }).click();

  // ── send (defaults to lien waiver) ─────────────────────────────────────────
  await page.getByRole("button", { name: "Send for signature" }).click();
  await expect(page.getByText("Sent", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy link" })).toBeVisible();

  // ── capture the real DocuSeal submission id from the row ────────────────────
  const [row] = await adminDb
    .select({ submissionId: esignRequest.docusealSubmissionId })
    .from(esignRequest)
    .where(eq(esignRequest.jobId, jobId));
  expect(row?.submissionId).toBeTruthy();

  // ── simulate the DocuSeal webhook (empty secret => no signature needed) ─────
  const res = await request.post("/api/docuseal/webhook", {
    headers: { "content-type": "application/json" },
    data: { event_type: "submission.completed", data: { submission_id: Number(row!.submissionId) } },
  });
  expect(res.status()).toBe(200);

  // ── the request flips to completed (reload to re-read) ──────────────────────
  await page.reload();
  await page.getByRole("button", { name: "E-sign" }).click();
  await expect(page.getByText("Completed", { exact: true })).toBeVisible();
});
