import { it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { adminDb, tenant, customer, property, job, supplierInvoice, creditRequest, eq } from "../index";
import { createCreditRequest, setCreditRequestSent, listOpenSentCreditRequests, markCreditRequestCredited, getCreditRecoverySummary } from "./credit-request";

let tenantId: string, jobId: string, siId: string;
beforeAll(async () => {
  tenantId = randomUUID();
  await adminDb.insert(tenant).values({ id: tenantId, name: "Guard Co", publicKey: `gc-${tenantId.slice(0, 8)}` });
  const [c] = await adminDb.insert(customer).values({ tenantId, name: "C" }).returning();
  const [p] = await adminDb.insert(property).values({ tenantId, customerId: c!.id, address: "1 Guard St" }).returning();
  const [j] = await adminDb.insert(job).values({ tenantId, customerId: c!.id, propertyId: p!.id, type: "retail", stage: "production" }).returning();
  jobId = j!.id;
  const [si] = await adminDb.insert(supplierInvoice).values({ tenantId, jobId, status: "guarded", totalCents: 500000, externalMessageId: `g-${randomUUID()}` }).returning();
  siId = si!.id;
});
afterAll(async () => {
  await adminDb.delete(creditRequest).where(eq(creditRequest.tenantId, tenantId));
  await adminDb.delete(supplierInvoice).where(eq(supplierInvoice.tenantId, tenantId));
  await adminDb.delete(job).where(eq(job.tenantId, tenantId));
  await adminDb.delete(property).where(eq(property.tenantId, tenantId));
  await adminDb.delete(customer).where(eq(customer.tenantId, tenantId));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
});

it("create → sent → credited, with recovery summary buckets", async () => {
  const { id } = await createCreditRequest(tenantId, { supplierInvoiceId: siId, jobId, supplierName: "ABC Supply", claimedCents: 30000, status: "sent", evidence: [{ overageCents: 30000 }] });
  await setCreditRequestSent(tenantId, id, { emailMessageId: "msg-1" });
  const open = await listOpenSentCreditRequests(tenantId, "ABC Supply");
  expect(open.map((r) => r.id)).toContain(id);

  const now = new Date();
  let summary = await getCreditRecoverySummary(tenantId, { start: new Date(now.getTime() - 86_400_000), end: new Date(now.getTime() + 86_400_000) });
  expect(summary.pendingCents).toBe(30000);
  expect(summary.recoveredCents).toBe(0);

  await markCreditRequestCredited(tenantId, id, 30000);
  const [row] = await adminDb.select().from(creditRequest).where(eq(creditRequest.id, id));
  expect(row!.status).toBe("credited");
  expect(row!.recoveredCents).toBe(30000);
  expect(row!.resolvedAt).not.toBeNull();

  summary = await getCreditRecoverySummary(tenantId, { start: new Date(now.getTime() - 86_400_000), end: new Date(now.getTime() + 86_400_000) });
  expect(summary.recoveredCents).toBe(30000);
  expect(summary.pendingCents).toBe(0);
});
