/**
 * e2e: supplier-invoice parse pipeline (cell 13b), AI-stubbed.
 *
 * Ingest webhook → `supplier-invoice/received` → durable `parseSupplierInvoice`
 * → stubbed AI gateway → matched job → parsed lines persisted → `job.costCents`
 * recomputed from supplier actuals. Runs on its OWN tenant so the deterministic
 * job-match (unique open material order) is reliable regardless of sibling specs.
 */
import { test, expect, request } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  adminDb, tenant, customer, property, job, estimate, materialOrder, supplierInvoice, document, withTenant, eq,
  materialReconciliation, materialReturn, materialLeftover,
} from "@savvy/db";

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("timed out waiting for parse");
    await new Promise((r) => setTimeout(r, 500));
  }
}

test("a received supplier invoice is parsed into actuals and updates job.costCents", async ({ baseURL }) => {
  const stamp = randomUUID().slice(0, 8);
  const token = `p${stamp}`; // inbox token is [A-Za-z0-9]+
  const tenantId = randomUUID();
  await adminDb.insert(tenant).values({
    id: tenantId, name: `Parse Co ${stamp}`, publicKey: `pc-${stamp}`, clerkOrgId: `org-parse-${stamp}`,
    settings: { supplierInbox: { token } },
  });
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "PC" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: `${stamp} Parse St` }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
  const [e] = await adminDb.insert(estimate).values({ tenantId, jobId: j!.id }).returning();
  // One OPEN material order → the parse's deterministic match resolves to this job.
  await adminDb.insert(materialOrder).values({ tenantId, jobId: j!.id, estimateId: e!.id, status: "ordered", lineItems: [], subtotalCents: 0, costSubtotalCents: 790000 });

  const messageId = `e2e-parse-${randomUUID()}`;
  const api = await request.newContext();
  const res = await api.post(`${baseURL}/api/inbound/supplier-invoice`, {
    headers: { "x-inbound-secret": "test-inbound-secret", "content-type": "application/json" },
    data: {
      messageId,
      to: `inv-${token}@inbox.getsavvy.com`,
      from: "billing@abcsupply.com",
      attachments: [{ filename: "abc.pdf", contentType: "application/pdf", bytesBase64: Buffer.from("%PDF-1.4 e2e parse").toString("base64") }],
    },
  });
  expect(res.status()).toBe(200);

  // The durable parse function runs via the Inngest dev server → poll until parsed.
  const parsed = await waitFor(async () => {
    const [row] = await withTenant(tenantId, (tx) =>
      tx.select().from(supplierInvoice).where(eq(supplierInvoice.externalMessageId, messageId)));
    return row?.status === "parsed" ? row : undefined;
  });

  expect(parsed.totalCents).toBe(234000);
  expect(parsed.jobId).toBe(j!.id);
  expect(parsed.parseConfidence).toBeGreaterThan(0.5);
  expect(Array.isArray(parsed.lines) ? parsed.lines.length : 0).toBe(1);

  // Cost actuals landed → job.costCents reflects the parsed supplier total.
  const [jobAfter] = await withTenant(tenantId, (tx) =>
    tx.select({ costCents: job.costCents }).from(job).where(eq(job.id, j!.id)));
  expect(jobAfter!.costCents).toBe(234000);

  // Cleanup this spec's isolated tenant.
  await adminDb.delete(supplierInvoice).where(eq(supplierInvoice.tenantId, tenantId));
  await adminDb.delete(document).where(eq(document.tenantId, tenantId));
  await adminDb.delete(materialOrder).where(eq(materialOrder.tenantId, tenantId));
  await adminDb.delete(estimate).where(eq(estimate.tenantId, tenantId));
  // Phase 26 slice 3: the guard fn auto-reconciles materials after parse — clear its rows before job
  await adminDb.delete(materialReturn).where(eq(materialReturn.tenantId, tenantId));
  await adminDb.delete(materialLeftover).where(eq(materialLeftover.tenantId, tenantId));
  await adminDb.delete(materialReconciliation).where(eq(materialReconciliation.tenantId, tenantId));
  await adminDb.delete(job).where(eq(job.tenantId, tenantId));
  await adminDb.delete(property).where(eq(property.tenantId, tenantId));
  await adminDb.delete(customer).where(eq(customer.tenantId, tenantId));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
});
