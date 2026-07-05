import "server-only";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { adminDb, withTenant, tenant, document, supplierInvoice, eq, sql } from "@savvy/db";
import type { StorageGateway } from "@savvy/integrations";
import { parseInboxToken } from "@savvy/core";

export type InboundBody = {
  messageId: string;
  to: string;
  from?: string;
  /** Optional email body/subject text forwarded by the provider. Used as extra context
   *  when building the AI parse prompt (e.g. e2e sentinel injection, future: subject hints). */
  emailBody?: string;
  attachments: { filename: string; contentType: string; bytesBase64: string }[];
};

type Deps = {
  expectedSecret: string;
  storage: StorageGateway;
  emit: (e: { tenantId: string; supplierInvoiceId: string; documentId: string; emailBody?: string }) => Promise<void>;
};

const isPdf = (a: InboundBody["attachments"][number]) =>
  a.contentType === "application/pdf" || a.filename.toLowerCase().endsWith(".pdf");

// Constant-time secret check that also rejects empty/mismatched-length inputs,
// so an empty incoming secret never authenticates.
function secretOk(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Inbound supplier-invoice email handler (provider-agnostic). Verifies the
 * shared secret, resolves the tenant from the inbox token, stores each PDF in
 * R2, inserts a document + supplier_invoice (idempotent on the email Message-Id),
 * and emits `supplier-invoice/received` for the parse slice (13b). Returns an
 * HTTP-shaped result so the route stays a thin wrapper (sitesnap pattern).
 */
export async function ingestSupplierInvoice(body: InboundBody, secret: string, deps: Deps): Promise<{ status: number; body: unknown }> {
  if (!secretOk(secret, deps.expectedSecret)) return { status: 401, body: { error: "unauthorized" } };
  if (!body?.messageId || !body?.to || !Array.isArray(body.attachments)) return { status: 400, body: { error: "bad_payload" } };

  const token = parseInboxToken(body.to);
  if (!token) return { status: 404, body: { error: "unknown_inbox" } };

  // Resolve tenant by inbox token (pre-tenant-context → adminDb). Few tenants → jsonb scan is fine.
  const [t] = await adminDb
    .select({ id: tenant.id })
    .from(tenant)
    .where(sql`${tenant.settings}->'supplierInbox'->>'token' = ${token}`);
  if (!t) return { status: 404, body: { error: "unknown_inbox" } };
  const tenantId = t.id;

  const pdfs = body.attachments.filter(isPdf);
  if (pdfs.length === 0) return { status: 202, body: { ignored: true } };

  const supplierName = body.from ? body.from.split("@")[1] ?? null : null; // provisional; parse (13b) overwrites
  let received = 0;

  for (const att of pdfs) {
    const bytes = new Uint8Array(Buffer.from(att.bytesBase64, "base64"));
    const key = `tenant/${tenantId}/supplier-invoice/${randomUUID()}.pdf`;
    await deps.storage.putObject({ key, bytes, contentType: "application/pdf" });

    const inserted = await withTenant(tenantId, async (tx) => {
      const [doc] = await tx.insert(document).values({
        tenantId, kind: "supplier_invoice", r2Key: key, filename: att.filename,
        mime: "application/pdf", sizeBytes: bytes.byteLength, source: "inbound_email",
      }).returning({ id: document.id });

      const [inv] = await tx.insert(supplierInvoice).values({
        tenantId, documentId: doc!.id, supplierName, senderEmail: body.from ?? null, externalMessageId: body.messageId, status: "received",
      }).onConflictDoNothing({ target: [supplierInvoice.tenantId, supplierInvoice.externalMessageId] }).returning({ id: supplierInvoice.id });

      // Already ingested (re-delivery, or a 2nd PDF in the same email) → drop the
      // orphan document we just created and skip. Keeps one invoice per Message-Id.
      if (!inv) {
        await tx.delete(document).where(eq(document.id, doc!.id));
        return null;
      }
      return { documentId: doc!.id, supplierInvoiceId: inv.id };
    });

    if (inserted) {
      await deps.emit({
        tenantId,
        ...inserted,
        ...(process.env.TEST_MODE === "1" ? { emailBody: body.emailBody } : {}),
      });
      received += 1;
    }
  }

  return { status: 200, body: { received } };
}
