import { pgTable, uuid, text, integer, real, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import type { SupplierInvoiceLine } from "@savvy/core";
import { idCol, createdAt, updatedAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";
import { job } from "./jobs";
import { document } from "./ops";
import { supplierInvoiceStatusEnum } from "./enums";

// A received supplier bill (ABC Supply, SRS, Beacon, …). Parsed into line-level
// actuals (13b) that replace the price-book estimate in job.costCents, then
// price-guarded vs the material-order snapshot (13c). One row per inbound email
// attachment; idempotent on the email Message-Id.
export const supplierInvoice = pgTable("supplier_invoice", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  jobId: uuid("job_id").references(() => job.id), // nullable — matched during parse (13b)
  documentId: uuid("document_id").references(() => document.id),
  supplierName: text("supplier_name"),
  invoiceNumber: text("invoice_number"),
  invoiceDate: timestamp("invoice_date", { withTimezone: true }),
  totalCents: integer("total_cents"), // negative for credit memos (13c)
  lines: jsonb("lines").$type<SupplierInvoiceLine[]>().notNull().default([]),
  status: supplierInvoiceStatusEnum("status").notNull().default("received"),
  parseConfidence: real("parse_confidence"),
  externalMessageId: text("external_message_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index("supplier_invoice_tenant_job_idx").on(t.tenantId, t.jobId),
  // NULL external_message_id is allowed many times (Postgres NULLs are distinct);
  // non-null message ids are unique per tenant → idempotent re-delivery.
  uniqueIndex("supplier_invoice_tenant_msg_uniq").on(t.tenantId, t.externalMessageId),
  tenantIsolation(),
]);
