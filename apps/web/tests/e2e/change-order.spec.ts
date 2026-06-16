import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminDb, withTenant, customer, property, job, changeOrder, invoice, eq } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 500));
  }
}

test("change order: create -> send -> webhook -> approved + draft invoice", async ({ page, request }) => {
  const stamp = randomUUID().slice(0, 8);
  const [cust] = await adminDb.insert(customer).values({ tenantId, name: `CO Carl ${stamp}`, email: `co-${stamp}@e2e.test` }).returning();
  const [prop] = await adminDb.insert(property).values({ tenantId, customerId: cust!.id, address: `${stamp} CO Way` }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: cust!.id, propertyId: prop!.id, type: "retail", stage: "production", valueFinal: 100000 }).returning();
  const jobId = j!.id;

  await page.goto(`/jobs/${jobId}`);
  await expect(page.getByTestId("job-detail")).toBeVisible();
  await page.getByTestId("create-change-order-btn").click();
  await expect(page.getByTestId("change-order-editor")).toBeVisible();
  await page.getByRole("button", { name: "+ Add row" }).click();
  await page.getByLabel("Unit price").first().fill("250.00");
  await page.getByRole("button", { name: "Save" }).click();

  await page.getByTestId("send-change-order-btn").click();
  const sent = await waitFor(async () => {
    const [row] = await adminDb.select().from(changeOrder).where(eq(changeOrder.jobId, jobId));
    return row?.status === "sent" && row.docusealSubmissionId ? row : undefined;
  });

  const res = await request.post("/api/docuseal/webhook", {
    data: { event_type: "form.completed", data: { submission_id: sent.docusealSubmissionId } },
  });
  expect(res.ok()).toBe(true);

  const approved = await waitFor(async () => {
    const [row] = await adminDb.select().from(changeOrder).where(eq(changeOrder.id, sent.id));
    return row?.status === "approved" && row.applied ? row : undefined;
  });
  expect(approved.approvedAt).not.toBeNull();
  const [jobAfter] = await withTenant(tenantId, (tx) => tx.select().from(job).where(eq(job.id, jobId)));
  expect(jobAfter!.valueFinal).toBe(125000);
  const invs = await adminDb.select().from(invoice).where(eq(invoice.jobId, jobId));
  expect(invs.length).toBe(1);
  expect(invs[0]!.status).toBe("draft");
  expect(invs[0]!.amountDue).toBe(25000);
});
