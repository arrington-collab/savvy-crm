import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  adminDb, ensurePriceBook, withTenant,
  tenant, user, customer, property, job, measurement, estimate, eq, and, desc,
} from "@savvy/db";
import { inngest } from "@savvy/agents";

const { id: tenantId } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string; key: string };

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 500));
  }
}

// 20 squares @ 8/12 pitch. With the seeded default price book (field shingles
// $120/sq + 12% waste, labor +20% steep surcharge, etc.) the estimate total is
// well above zero — we assert > 0 rather than a brittle exact figure.
test("estimate: measurement -> generated draft -> send -> e-sign webhook -> job approved", async ({ page, request }) => {
  const stamp = randomUUID().slice(0, 8);

  // ---- 1) Seed tenant config + price book + job + measurement ----------------
  await adminDb.update(tenant)
    .set({ settings: { estimate: { taxRateBps: 830, defaultWastePct: 1200 } } })
    .where(eq(tenant.id, tenantId));
  await ensurePriceBook(tenantId);

  const [rep] = await adminDb.insert(user).values({
    tenantId, name: `Rep ${stamp}`, email: `rep-${stamp}@e2e.test`, role: "rep",
  }).returning();
  const [cust] = await adminDb.insert(customer).values({
    tenantId, name: `Estimate Eddie ${stamp}`, email: `eddie-${stamp}@e2e.test`,
  }).returning();
  const [prop] = await adminDb.insert(property).values({
    tenantId, customerId: cust!.id, address: `${stamp} Estimate Way`,
  }).returning();
  const [j] = await adminDb.insert(job).values({
    tenantId, customerId: cust!.id, propertyId: prop!.id, type: "retail", stage: "estimate", assignedUserId: rep!.id,
  }).returning();
  const [m] = await withTenant(tenantId, (tx) => tx.insert(measurement).values({
    tenantId, propertyId: prop!.id, provider: "roofr", pitch: "8/12",
    areas: { squares: 20, predominantPitch: "8/12", eaveLf: 120, rakeLf: 60, ridgeLf: 30, hipLf: 10, valleyLf: 10, penetrationCount: 4 },
  }).returning());
  const jobId = j!.id;

  // ---- 2) Fire measurement/ready -> generate workflow drafts an estimate -----
  await inngest.send({ name: "measurement/ready", data: { tenantId, jobId, measurementId: m!.id } });
  const draft = await waitFor(async () => {
    const [row] = await adminDb.select().from(estimate)
      .where(and(eq(estimate.tenantId, tenantId), eq(estimate.jobId, jobId)))
      .orderBy(desc(estimate.createdAt));
    return row;
  });
  expect(draft.status).toBe("draft");
  expect(draft.source).toBe("roofr");
  expect(draft.total ?? 0).toBeGreaterThan(0);
  const estimateId = draft.id;

  // ---- 3) Editor renders the estimate ----------------------------------------
  await page.goto(`/jobs/${jobId}/estimates/${estimateId}`);
  await expect(page.getByTestId("estimate-editor")).toBeVisible();
  await expect(page.getByTestId("estimate-total")).toBeVisible();

  // ---- 4) Send for signature -> workflow flips to sent + records submission --
  await inngest.send({ name: "estimate/send.requested", data: { tenantId, estimateId } });
  const sent = await waitFor(async () => {
    const [row] = await adminDb.select().from(estimate).where(eq(estimate.id, estimateId));
    return row?.status === "sent" && row.docusealSubmissionId ? row : undefined;
  });
  expect(sent.docusealSubmissionId).toBeTruthy();

  // ---- 5) DocuSeal completed webhook -> accepted + job advances to approved ---
  const res = await request.post("/api/docuseal/webhook", {
    data: { event_type: "form.completed", data: { submission_id: sent.docusealSubmissionId } },
  });
  expect(res.ok()).toBe(true);

  const accepted = await waitFor(async () => {
    const [row] = await adminDb.select().from(estimate).where(eq(estimate.id, estimateId));
    return row?.status === "accepted" ? row : undefined;
  });
  expect(accepted.acceptedAt).not.toBeNull();

  const approvedJob = await waitFor(async () => {
    const [row] = await adminDb.select().from(job).where(eq(job.id, jobId));
    return row?.stage === "approved" ? row : undefined;
  });
  expect(approvedJob.valueEstimate).toBe(accepted.total);
});
