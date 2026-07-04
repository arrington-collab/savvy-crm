import { it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { adminDb, tenant, supplierInvoice, document, withTenant, eq } from "@savvy/db";
import { makeFakeStorage } from "@savvy/integrations";
import { ingestSupplierInvoice, type InboundBody } from "./supplier-invoice-ingest";

const TOKEN = "guardtok1";
let tenantId: string;

const pdf = (filename = "abc.pdf"): InboundBody => ({
  messageId: `msg-${randomUUID()}`,
  to: `inv-${TOKEN}@inbox.getsavvy.com`,
  from: "billing@abcsupply.com",
  attachments: [{ filename, contentType: "application/pdf", bytesBase64: Buffer.from("%PDF-1.4 fake").toString("base64") }],
});

beforeAll(async () => {
  tenantId = randomUUID();
  await adminDb.insert(tenant).values({ id: tenantId, name: "Guard Co", publicKey: `gc-${tenantId.slice(0, 8)}`, settings: { supplierInbox: { token: TOKEN } } });
});
afterAll(async () => {
  await adminDb.delete(supplierInvoice).where(eq(supplierInvoice.tenantId, tenantId));
  await adminDb.delete(document).where(eq(document.tenantId, tenantId));
  await adminDb.delete(tenant).where(eq(tenant.id, tenantId));
});

const deps = (emit: (e: { tenantId: string; supplierInvoiceId: string; documentId: string }) => Promise<void>) => ({
  expectedSecret: "s3cret",
  storage: makeFakeStorage(),
  emit,
});

it("rejects a bad secret", async () => {
  const res = await ingestSupplierInvoice(pdf(), "wrong", deps(async () => {}));
  expect(res.status).toBe(401);
});

it("404s an unknown inbox token", async () => {
  const body = { ...pdf(), to: "inv-nope@inbox.getsavvy.com" };
  const res = await ingestSupplierInvoice(body, "s3cret", deps(async () => {}));
  expect(res.status).toBe(404);
});

it("stores the PDF, inserts document + supplier_invoice, and emits once", async () => {
  const emitted: { tenantId: string; supplierInvoiceId: string; documentId: string }[] = [];
  const body = pdf();
  const res = await ingestSupplierInvoice(body, "s3cret", deps(async (e) => { emitted.push(e); }));
  expect(res.status).toBe(200);
  expect(emitted).toHaveLength(1);
  const rows = await withTenant(tenantId, (tx) => tx.select().from(supplierInvoice).where(eq(supplierInvoice.externalMessageId, body.messageId)));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe("received");
  const docs = await withTenant(tenantId, (tx) => tx.select().from(document).where(eq(document.id, emitted[0]!.documentId)));
  expect(docs[0]!.kind).toBe("supplier_invoice");
});

it("is idempotent on a re-delivered messageId", async () => {
  const emitted: unknown[] = [];
  const body = pdf();
  await ingestSupplierInvoice(body, "s3cret", deps(async (e) => { emitted.push(e); }));
  await ingestSupplierInvoice(body, "s3cret", deps(async (e) => { emitted.push(e); }));
  const rows = await withTenant(tenantId, (tx) => tx.select().from(supplierInvoice).where(eq(supplierInvoice.externalMessageId, body.messageId)));
  expect(rows).toHaveLength(1);
  expect(emitted).toHaveLength(1); // second delivery is a no-op → no second emit
});

it("202-ignores an email with no PDF attachment", async () => {
  const body = { ...pdf(), attachments: [{ filename: "note.txt", contentType: "text/plain", bytesBase64: "eA==" }] };
  const res = await ingestSupplierInvoice(body, "s3cret", deps(async () => {}));
  expect(res.status).toBe(202);
});
