/**
 * e2e: supplier-invoice price-guard pipeline (cell 13c), AI-stubbed.
 *
 * Ingest webhook → parse (GUARD-SENTINEL stub) → `supplier-invoice/parsed` →
 * priceGuardHandler → guarded + credit_request (auto-sent). Then a credit memo
 * (CREDIT-MEMO-SENTINEL stub) → recoverCreditMemoHandler → credit_request.status=credited.
 * Also verifies the `/money` proof panel and `/jobs/{id}` supplier-invoices panel.
 *
 * Uses its OWN isolated tenant so deterministic job-match is reliable.
 */
import { test, expect, request } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  adminDb, tenant, customer, property, job, estimate, materialOrder,
  priceBookItem, supplierInvoice, creditRequest, agentRun, document,
  verificationRun, taskRegistry, withTenant, eq,
} from "@savvy/db";
import type { SupplierInvoiceLine } from "@savvy/core";

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ---------------------------------------------------------------------------
// Pipeline test: isolated tenant — full guard → credit-request → credit memo
// ---------------------------------------------------------------------------
test("price-guard: guarded invoice creates credit request; credit memo marks it credited", async ({ baseURL }) => {
  const stamp = randomUUID().slice(0, 8);
  const token = `g${stamp}`;
  const tenantId = randomUUID();

  // Seed isolated tenant
  await adminDb.insert(tenant).values({
    id: tenantId, name: `Guard Co ${stamp}`, publicKey: `gc-${stamp}`, clerkOrgId: `org-guard-${stamp}`,
    settings: { supplierInbox: { token } },
  });
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "GC" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: `${stamp} Guard Ave` }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
  const [e] = await adminDb.insert(estimate).values({ tenantId, jobId: j!.id }).returning();

  // Material order with shingle-hdz at $70/unit cost (the guard baseline snapshot)
  await adminDb.insert(materialOrder).values({
    tenantId, jobId: j!.id, estimateId: e!.id, status: "ordered",
    lineItems: [{ key: "shingle-hdz", name: "GAF Timberline HDZ", quantity: 30, unit: "square" as const, unitPriceCents: 9500, amountCents: 285000, unitCostCents: 7000, lineCostCents: 210000 }],
    subtotalCents: 285000, costSubtotalCents: 210000,
  });

  // Price book item so getMaterialOrderSnapshot can resolve unitCostCents by key
  await adminDb.insert(priceBookItem).values({
    tenantId, key: "shingle-hdz", name: "GAF Timberline HDZ", category: "material",
    unit: "square", unitPriceCents: 9500, unitCostCents: 7000,
    sourceFields: ["squares"], wasteApplies: true,
  });

  try {
    const api = await request.newContext();

    // ---- Part 1: POST guard invoice (GUARD-SENTINEL → stub returns sku=shingle-hdz, unitBilledCents=8000) ----
    const guardMessageId = `e2e-guard-inv-${randomUUID()}`;
    const res1 = await api.post(`${baseURL}/api/inbound/supplier-invoice`, {
      headers: { "x-inbound-secret": "test-inbound-secret", "content-type": "application/json" },
      data: {
        messageId: guardMessageId,
        to: `inv-${token}@inbox.getsavvy.com`,
        from: "billing@abcsupply.com",
        // Sentinel: injected into the AI prompt → stub branches on it to return guard response
        emailBody: "GUARD-SENTINEL",
        attachments: [{
          filename: "invoice.pdf",
          contentType: "application/pdf",
          bytesBase64: Buffer.from("%PDF-1.4 guard-invoice-e2e").toString("base64"),
        }],
      },
    });
    expect(res1.status()).toBe(200);

    // Poll: parse → guard should both complete; final status = "guarded"
    const guarded = await waitFor(async () => {
      const [row] = await withTenant(tenantId, (tx) =>
        tx.select().from(supplierInvoice).where(eq(supplierInvoice.externalMessageId, guardMessageId)));
      return row?.status === "guarded" ? row : undefined;
    });

    // Assert guard annotations on line 0
    const lines = (guarded.lines ?? []) as SupplierInvoiceLine[];
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]!.matchedItemKey).toBe("shingle-hdz");
    // (8000 - 7000) * 30 = 30 000 cents overage
    expect(lines[0]!.overageCents).toBe(30000);

    // Assert credit_request was created for this invoice
    const [cr] = await withTenant(tenantId, (tx) =>
      tx.select().from(creditRequest).where(eq(creditRequest.supplierInvoiceId, guarded.id)));
    expect(cr).toBeTruthy();
    expect(cr!.claimedCents).toBe(30000);
    expect(["sent", "drafted"]).toContain(cr!.status);

    // ---- Part 2: POST credit memo (CREDIT-MEMO-SENTINEL → stub returns totalCents=-30000) ----
    const creditMemoMessageId = `e2e-credit-memo-${randomUUID()}`;
    const res2 = await api.post(`${baseURL}/api/inbound/supplier-invoice`, {
      headers: { "x-inbound-secret": "test-inbound-secret", "content-type": "application/json" },
      data: {
        messageId: creditMemoMessageId,
        to: `inv-${token}@inbox.getsavvy.com`,
        from: "billing@abcsupply.com",
        emailBody: "CREDIT-MEMO-SENTINEL",
        attachments: [{
          filename: "credit-memo.pdf",
          contentType: "application/pdf",
          bytesBase64: Buffer.from("%PDF-1.4 credit-memo-e2e").toString("base64"),
        }],
      },
    });
    expect(res2.status()).toBe(200);

    // Poll: credit request should be marked credited after the memo's guard function runs
    await waitFor(async () => {
      const [row] = await withTenant(tenantId, (tx) =>
        tx.select({ status: creditRequest.status, recoveredCents: creditRequest.recoveredCents })
          .from(creditRequest).where(eq(creditRequest.id, cr!.id)));
      return row?.status === "credited" ? row : undefined;
    });

    const [crAfter] = await withTenant(tenantId, (tx) =>
      tx.select({ status: creditRequest.status, recoveredCents: creditRequest.recoveredCents })
        .from(creditRequest).where(eq(creditRequest.id, cr!.id)));
    expect(crAfter!.status).toBe("credited");
    expect(crAfter!.recoveredCents).toBe(30000);

  } finally {
    // Teardown in FK order
    await adminDb.delete(agentRun).where(eq(agentRun.tenantId, tenantId));
    await adminDb.delete(creditRequest).where(eq(creditRequest.tenantId, tenantId));
    await adminDb.delete(supplierInvoice).where(eq(supplierInvoice.tenantId, tenantId));
    await adminDb.delete(document).where(eq(document.tenantId, tenantId));
    await adminDb.delete(materialOrder).where(eq(materialOrder.tenantId, tenantId));
    await adminDb.delete(estimate).where(eq(estimate.tenantId, tenantId));
    await adminDb.delete(job).where(eq(job.tenantId, tenantId));
    await adminDb.delete(property).where(eq(property.tenantId, tenantId));
    await adminDb.delete(customer).where(eq(customer.tenantId, tenantId));
    await adminDb.delete(priceBookItem).where(eq(priceBookItem.tenantId, tenantId));
    await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
  }
});

// ---------------------------------------------------------------------------
// UI test: /money proof panel shows finance.price_guard row
// ---------------------------------------------------------------------------
test("Money proof panel renders the finance.price_guard row", async ({ page }) => {
  let mainTenantId: string;
  try {
    ({ id: mainTenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string });
  } catch {
    test.skip(true, "no e2e tenant file — run create-tenant first");
    return;
  }

  // The verification_run table has a FK to task_registry.id.
  const [reg] = await adminDb.select({ id: taskRegistry.id }).from(taskRegistry).limit(1);
  if (!reg) {
    test.skip(true, "task_registry not seeded in this environment");
    return;
  }

  // Seed a passing finance.price_guard verification run so the proof panel has a row to show.
  const [vr] = await adminDb.insert(verificationRun).values({
    tenantId: mainTenantId,
    taskId: reg.id,
    checkKey: "finance.price_guard",
    status: "pass",
    details: { message: "all supplier invoices price-checked (e2e seed)" },
    refs: [],
  }).returning();

  try {
    await page.goto("/money");
    await expect(page.getByTestId("proof-panel")).toBeVisible({ timeout: 15_000 });

    const row = page.locator('[data-testid="proof-row"]', { hasText: "finance.price_guard" });
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("data-status", "pass");
    await expect(row).toContainText("PASS");
  } finally {
    if (vr) await adminDb.delete(verificationRun).where(eq(verificationRun.id, vr.id));
  }
});

// ---------------------------------------------------------------------------
// UI test: /jobs/{id} supplier-invoices panel shows overage
// ---------------------------------------------------------------------------
test("Job detail supplier-invoices panel renders guard overage", async ({ page }) => {
  let mainTenantId: string;
  try {
    ({ id: mainTenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string });
  } catch {
    test.skip(true, "no e2e tenant file — run create-tenant first");
    return;
  }

  const stamp = randomUUID().slice(0, 8);
  const [c] = await adminDb.insert(customer).values({ tenantId: mainTenantId, name: `GuardUI ${stamp}` }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId: mainTenantId, customerId: c!.id, address: `${stamp} Overage Blvd` }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId: mainTenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();

  // Seed a guarded supplier invoice with the overage annotation directly (no Inngest needed)
  const guardedLines: SupplierInvoiceLine[] = [{
    description: "GAF Timberline HDZ",
    sku: "shingle-hdz",
    quantity: 30,
    unit: "SQ",
    unitBilledCents: 8000,
    amountBilledCents: 240000,
    matchedItemKey: "shingle-hdz",
    expectedUnitCostCents: 7000,
    overageCents: 30000,
    matchConfidence: 1,
  }];
  const [si] = await adminDb.insert(supplierInvoice).values({
    tenantId: mainTenantId,
    jobId: j!.id,
    supplierName: "ABC Supply",
    invoiceNumber: "INV-GUARD-UI",
    totalCents: 240000,
    lines: guardedLines,
    status: "guarded",
    parseConfidence: 0.95,
    externalMessageId: `e2e-guard-ui-${randomUUID()}`,
  }).returning();

  try {
    await page.goto(`/jobs/${j!.id}`);

    const panel = page.getByTestId("supplier-invoices-panel");
    await expect(panel).toBeVisible({ timeout: 15_000 });
    // The overage badge should show the +$300.00 overage
    await expect(panel).toContainText("over");
  } finally {
    await adminDb.delete(supplierInvoice).where(eq(supplierInvoice.id, si!.id));
    await adminDb.delete(job).where(eq(job.id, j!.id));
    await adminDb.delete(property).where(eq(property.id, p!.id));
    await adminDb.delete(customer).where(eq(customer.id, c!.id));
  }
});
