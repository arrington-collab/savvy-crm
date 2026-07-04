/**
 * e2e: inbound supplier-invoice webhook (cell 13a).
 *
 * Seeds the inbox token on the e2e tenant, POSTs a forwarded-email payload to
 * the real route, and asserts a document + supplier_invoice land tenant-scoped.
 */
import { test, expect, request } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { adminDb, tenant, supplierInvoice, withTenant, eq } from "@savvy/db";

const { id: tenantId } = JSON.parse(readFileSync("/tmp/savvy-e2e-tenant.json", "utf8")) as { id: string };
const TOKEN = "e2eguard";

test.beforeAll(async () => {
  const [t] = await adminDb.select({ settings: tenant.settings }).from(tenant).where(eq(tenant.id, tenantId));
  const settings = { ...((t?.settings as object) ?? {}), supplierInbox: { token: TOKEN } };
  await adminDb.update(tenant).set({ settings }).where(eq(tenant.id, tenantId));
});

test("a forwarded supplier invoice lands as a document + supplier_invoice", async ({ baseURL }) => {
  const messageId = `e2e-${randomUUID()}`;
  const api = await request.newContext();
  const res = await api.post(`${baseURL}/api/inbound/supplier-invoice`, {
    headers: { "x-inbound-secret": "test-inbound-secret", "content-type": "application/json" },
    data: {
      messageId,
      to: `inv-${TOKEN}@inbox.getsavvy.com`,
      from: "billing@abcsupply.com",
      attachments: [{ filename: "abc.pdf", contentType: "application/pdf", bytesBase64: Buffer.from("%PDF-1.4 e2e").toString("base64") }],
    },
  });
  expect(res.status()).toBe(200);

  const rows = await withTenant(tenantId, (tx) => tx.select().from(supplierInvoice).where(eq(supplierInvoice.externalMessageId, messageId)));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe("received");
  expect(rows[0]!.documentId).toBeTruthy();
});

test("the webhook rejects a bad secret", async ({ baseURL }) => {
  const api = await request.newContext();
  const res = await api.post(`${baseURL}/api/inbound/supplier-invoice`, {
    headers: { "x-inbound-secret": "wrong", "content-type": "application/json" },
    data: { messageId: `e2e-${randomUUID()}`, to: `inv-${TOKEN}@inbox.getsavvy.com`, attachments: [] },
  });
  expect(res.status()).toBe(401);
});

test("the webhook rejects an empty secret (no fail-open)", async ({ baseURL }) => {
  const api = await request.newContext();
  const res = await api.post(`${baseURL}/api/inbound/supplier-invoice`, {
    headers: { "x-inbound-secret": "", "content-type": "application/json" },
    data: { messageId: `e2e-${randomUUID()}`, to: `inv-${TOKEN}@inbox.getsavvy.com`, attachments: [] },
  });
  expect(res.status()).toBe(401);
});

test("the webhook 404s an unknown inbox token", async ({ baseURL }) => {
  const api = await request.newContext();
  const res = await api.post(`${baseURL}/api/inbound/supplier-invoice`, {
    headers: { "x-inbound-secret": "test-inbound-secret", "content-type": "application/json" },
    data: { messageId: `e2e-${randomUUID()}`, to: "inv-nosuchtoken@inbox.getsavvy.com",
      attachments: [{ filename: "x.pdf", contentType: "application/pdf", bytesBase64: "JVBERg==" }] },
  });
  expect(res.status()).toBe(404);
});

test("re-delivering the same Message-Id is idempotent (one row)", async ({ baseURL }) => {
  const messageId = `e2e-${randomUUID()}`;
  const payload = {
    headers: { "x-inbound-secret": "test-inbound-secret", "content-type": "application/json" },
    data: { messageId, to: `inv-${TOKEN}@inbox.getsavvy.com`, from: "billing@srs.com",
      attachments: [{ filename: "srs.pdf", contentType: "application/pdf", bytesBase64: Buffer.from("%PDF dup").toString("base64") }] },
  };
  const api = await request.newContext();
  await api.post(`${baseURL}/api/inbound/supplier-invoice`, payload);
  await api.post(`${baseURL}/api/inbound/supplier-invoice`, payload);
  const rows = await withTenant(tenantId, (tx) => tx.select().from(supplierInvoice).where(eq(supplierInvoice.externalMessageId, messageId)));
  expect(rows).toHaveLength(1);
});

test("an email with no PDF attachment is ignored (202)", async ({ baseURL }) => {
  const api = await request.newContext();
  const res = await api.post(`${baseURL}/api/inbound/supplier-invoice`, {
    headers: { "x-inbound-secret": "test-inbound-secret", "content-type": "application/json" },
    data: { messageId: `e2e-${randomUUID()}`, to: `inv-${TOKEN}@inbox.getsavvy.com`,
      attachments: [{ filename: "note.txt", contentType: "text/plain", bytesBase64: "aGk=" }] },
  });
  expect(res.status()).toBe(202);
});
