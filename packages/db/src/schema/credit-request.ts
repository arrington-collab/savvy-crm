import { pgTable, uuid, text, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { idCol, createdAt, updatedAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";
import { job } from "./jobs";
import { supplierInvoice } from "./supplier-invoice";
import { creditRequestStatusEnum } from "./enums";

// The recovery ledger — the "found money" the digest reports. One row per overage
// claim raised against a parsed supplier invoice; auto-recovered when a matching
// credit memo lands (status→credited, recoveredCents set).
export const creditRequest = pgTable("credit_request", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  supplierInvoiceId: uuid("supplier_invoice_id").notNull().references(() => supplierInvoice.id),
  jobId: uuid("job_id").references(() => job.id), // nullable
  supplierName: text("supplier_name"),
  claimedCents: integer("claimed_cents").notNull().default(0),
  status: creditRequestStatusEnum("status").notNull().default("drafted"),
  evidence: jsonb("evidence").$type<unknown>().notNull().default([]), // overage lines: expected vs billed, delta
  sentAt: timestamp("sent_at", { withTimezone: true }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  recoveredCents: integer("recovered_cents").notNull().default(0),
  emailMessageId: text("email_message_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index("credit_request_tenant_supplier_idx").on(t.tenantId, t.supplierName),
  index("credit_request_tenant_status_idx").on(t.tenantId, t.status),
  tenantIsolation(),
]);
