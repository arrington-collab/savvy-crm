import { pgTable, uuid, text, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls.js";
import { tenant } from "./tenancy.js";
import { job } from "./jobs.js";

export const estimate = pgTable("estimate", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  jobId: uuid("job_id").notNull().references(() => job.id),
  source: text("source").notNull().default("manual"), // roofr|manual|carrier
  status: text("status").notNull().default("draft"),  // draft|sent|accepted
  lineItems: jsonb("line_items").$type<unknown[]>().default([]).notNull(),
  subtotal: integer("subtotal"),
  tax: integer("tax"),
  total: integer("total"),
  esxUrl: text("esx_url"),
  createdAt: createdAt(),
}, (t) => [index("estimate_tenant_job_idx").on(t.tenantId, t.jobId), tenantIsolation()]);

export const invoice = pgTable("invoice", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  jobId: uuid("job_id").notNull().references(() => job.id),
  number: text("number"),
  status: text("status").notNull().default("draft"), // draft|sent|paid|overdue|void
  lineItems: jsonb("line_items").$type<unknown[]>().default([]).notNull(),
  amountDue: integer("amount_due"),
  amountPaid: integer("amount_paid").default(0).notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }),
  stripeInvoiceId: text("stripe_invoice_id"),
  qboId: text("qbo_id"),
  createdAt: createdAt(),
}, (t) => [index("invoice_tenant_status_idx").on(t.tenantId, t.status), tenantIsolation()]);

export const payment = pgTable("payment", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  invoiceId: uuid("invoice_id").notNull().references(() => invoice.id),
  method: text("method").notNull(), // card|ach|check|insurance|mortgage
  amount: integer("amount").notNull(),
  stripePaymentId: text("stripe_payment_id"),
  receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("payment_tenant_invoice_idx").on(t.tenantId, t.invoiceId), tenantIsolation()]);
