import { it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { adminDb, tenant, customer, property, job, supplierInvoice, eq } from "../index.js";
import { recomputeJobActualCost, saveParsedSupplierInvoice } from "./supplier-invoice.js";

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
