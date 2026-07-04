import { it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { adminDb, tenant, customer, property, job, estimate, materialOrder, document, supplierInvoice, priceBookItem, eq } from "../index";
import {
  recomputeJobActualCost, saveParsedSupplierInvoice,
  getDocumentR2Key, matchSupplierInvoiceJob, markSupplierInvoiceParseFailed,
  getMaterialOrderSnapshot,
} from "./supplier-invoice";

let tenantId: string, jobId: string;

beforeAll(async () => {
  tenantId = randomUUID();
  await adminDb.insert(tenant).values({ id: tenantId, name: "Cost Co", publicKey: `cc-${tenantId.slice(0, 8)}` });
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "C" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "1 Cost St" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
  jobId = j!.id;
});
afterAll(async () => {
  await adminDb.delete(supplierInvoice).where(eq(supplierInvoice.tenantId, tenantId));
  await adminDb.delete(document).where(eq(document.tenantId, tenantId));
  await adminDb.delete(materialOrder).where(eq(materialOrder.tenantId, tenantId));
  await adminDb.delete(estimate).where(eq(estimate.tenantId, tenantId));
  await adminDb.delete(priceBookItem).where(eq(priceBookItem.tenantId, tenantId));
  await adminDb.delete(job).where(eq(job.tenantId, tenantId));
  await adminDb.delete(property).where(eq(property.tenantId, tenantId));
  await adminDb.delete(customer).where(eq(customer.tenantId, tenantId));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
});

it("saveParsedSupplierInvoice persists parsed fields + status=parsed", async () => {
  const [si] = await adminDb.insert(supplierInvoice).values({ tenantId, status: "received", externalMessageId: `s-${randomUUID()}` }).returning();
  await saveParsedSupplierInvoice(tenantId, si!.id, {
    supplierName: "ABC Supply", invoiceNumber: "INV-9", invoiceDate: new Date("2026-07-01T00:00:00Z"),
    totalCents: 500000, lines: [{ description: "shingles", quantity: 20, unitBilledCents: 25000, amountBilledCents: 500000 }],
    confidence: 0.9, jobId,
  });
  const [row] = await adminDb.select().from(supplierInvoice).where(eq(supplierInvoice.id, si!.id));
  expect(row!.status).toBe("parsed");
  expect(row!.totalCents).toBe(500000);
  expect(row!.jobId).toBe(jobId);
});

it("recomputeJobActualCost sets job.costCents to the sum of parsed supplier-invoice actuals", async () => {
  // own job so test 1's parsed invoice doesn't pollute the sum
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "C2" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "2 Cost St" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
  await adminDb.insert(supplierInvoice).values([
    { tenantId, jobId: j!.id, status: "parsed", totalCents: 500000, externalMessageId: `a-${randomUUID()}` },
    { tenantId, jobId: j!.id, status: "parsed", totalCents: 312300, externalMessageId: `b-${randomUUID()}` },
    { tenantId, jobId: j!.id, status: "received", totalCents: 999999, externalMessageId: `c-${randomUUID()}` }, // not parsed → excluded
  ]);
  await recomputeJobActualCost(tenantId, j!.id);
  const [row] = await adminDb.select({ costCents: job.costCents }).from(job).where(eq(job.id, j!.id));
  expect(row!.costCents).toBe(812300);
});

it("getDocumentR2Key returns the tenant's document key, null when absent", async () => {
  const [doc] = await adminDb.insert(document).values({ tenantId, kind: "evidence", r2Key: "tenant/x/supplier-invoice/y.pdf" }).returning();
  expect(await getDocumentR2Key(tenantId, doc!.id)).toBe("tenant/x/supplier-invoice/y.pdf");
  expect(await getDocumentR2Key(tenantId, randomUUID())).toBeNull();
});

it("markSupplierInvoiceParseFailed flips status to parse_failed", async () => {
  const [si] = await adminDb.insert(supplierInvoice).values({ tenantId, status: "received", externalMessageId: `pf-${randomUUID()}` }).returning();
  await markSupplierInvoiceParseFailed(tenantId, si!.id);
  const [row] = await adminDb.select({ status: supplierInvoice.status }).from(supplierInvoice).where(eq(supplierInvoice.id, si!.id));
  expect(row!.status).toBe("parse_failed");
});

it("matchSupplierInvoiceJob returns the unique open-order job, null when ambiguous", async () => {
  const t3 = randomUUID();
  await adminDb.insert(tenant).values({ id: t3, name: "Match Co", publicKey: `mc-${t3.slice(0, 8)}` });
  const [c] = await adminDb.insert(customer).values({ tenantId: t3, name: "MC" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId: t3, customerId: c!.id, address: "9 Match St" }).returning();
  const mkOrderedJob = async () => {
    const [j] = await adminDb.insert(job).values({ tenantId: t3, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
    const [e] = await adminDb.insert(estimate).values({ tenantId: t3, jobId: j!.id }).returning();
    await adminDb.insert(materialOrder).values({ tenantId: t3, jobId: j!.id, estimateId: e!.id, status: "ordered", lineItems: [], subtotalCents: 0, costSubtotalCents: 100000 });
    return j!.id;
  };
  const only = await mkOrderedJob();
  expect(await matchSupplierInvoiceJob(t3, { supplierName: "ABC" })).toBe(only); // exactly one → match
  await mkOrderedJob(); // second open-order job → ambiguous
  expect(await matchSupplierInvoiceJob(t3, { supplierName: "ABC" })).toBeNull();

  await adminDb.delete(materialOrder).where(eq(materialOrder.tenantId, t3));
  await adminDb.delete(estimate).where(eq(estimate.tenantId, t3));
  await adminDb.delete(job).where(eq(job.tenantId, t3));
  await adminDb.delete(property).where(eq(property.tenantId, t3));
  await adminDb.delete(customer).where(eq(customer.tenantId, t3));
  await adminDb.delete(tenant).where(eq(tenant.id, t3));
});

it("getMaterialOrderSnapshot returns lines with unitCostCents (line value + price-book fallback)", async () => {
  const t4 = randomUUID();
  await adminDb.insert(tenant).values({ id: t4, name: "Snapshot Co", publicKey: `sc-${t4.slice(0, 8)}` });
  const [c] = await adminDb.insert(customer).values({ tenantId: t4, name: "SC" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId: t4, customerId: c!.id, address: "5 Snap St" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId: t4, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
  const [e] = await adminDb.insert(estimate).values({ tenantId: t4, jobId: j!.id }).returning();
  // price book item for fallback (key "ridge-cap", no unitCostCents on the line)
  await adminDb.insert(priceBookItem).values({ tenantId: t4, key: "ridge-cap", name: "Ridge Cap", category: "material", unit: "lf", unitPriceCents: 500, unitCostCents: 350 });
  await adminDb.insert(materialOrder).values({
    tenantId: t4, jobId: j!.id, estimateId: e!.id, status: "ordered",
    lineItems: [
      // line with explicit unitCostCents
      { key: "shingle-30yr", name: "30yr Shingle", quantity: 20, unit: "square", unitPriceCents: 10000, amountCents: 200000, unitCostCents: 7500 },
      // line WITHOUT unitCostCents — should fall back to price book
      { key: "ridge-cap", name: "Ridge Cap", quantity: 10, unit: "lf", unitPriceCents: 500, amountCents: 5000 },
    ],
    subtotalCents: 205000, costSubtotalCents: 150000,
  });

  const snap = await getMaterialOrderSnapshot(t4, j!.id);
  expect(snap).toHaveLength(2);
  const shingle = snap.find((s) => s.key === "shingle-30yr");
  expect(shingle?.unitCostCents).toBe(7500);
  const ridge = snap.find((s) => s.key === "ridge-cap");
  expect(ridge?.unitCostCents).toBe(350); // from price book fallback

  // cleanup
  await adminDb.delete(materialOrder).where(eq(materialOrder.tenantId, t4));
  await adminDb.delete(estimate).where(eq(estimate.tenantId, t4));
  await adminDb.delete(priceBookItem).where(eq(priceBookItem.tenantId, t4));
  await adminDb.delete(job).where(eq(job.tenantId, t4));
  await adminDb.delete(property).where(eq(property.tenantId, t4));
  await adminDb.delete(customer).where(eq(customer.tenantId, t4));
  await adminDb.delete(tenant).where(eq(tenant.id, t4));
});

it("recomputeJobActualCost counts guarded invoices as actuals", async () => {
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "CG" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "9 Guard St" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
  await adminDb.insert(supplierInvoice).values({ tenantId, jobId: j!.id, status: "guarded", totalCents: 444000, externalMessageId: `gd-${randomUUID()}` });
  await recomputeJobActualCost(tenantId, j!.id);
  const [row] = await adminDb.select({ costCents: job.costCents }).from(job).where(eq(job.id, j!.id));
  expect(row!.costCents).toBe(444000);
});
