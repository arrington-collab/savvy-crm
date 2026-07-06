import { pgTable, uuid, text, integer, timestamp, jsonb, index, uniqueIndex, boolean } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant, user } from "./tenancy";
import { job } from "./jobs";
import { customer } from "./crm";
import { invoiceStatusEnum, paymentMethodEnum, commissionModelEnum, commissionStatusEnum } from "./enums";
import { contractTemplate } from "./compliance";

export const estimate = pgTable("estimate", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  jobId: uuid("job_id").notNull().references(() => job.id),
  source: text("source").notNull().default("manual"), // roofr|diy|manual|carrier
  status: text("status").notNull().default("draft"),  // draft|sent|accepted
  lineItems: jsonb("line_items").$type<unknown[]>().default([]).notNull(),
  subtotal: integer("subtotal"),
  tax: integer("tax"),
  total: integer("total"),
  esxUrl: text("esx_url"),
  measurementId: uuid("measurement_id"),
  wastePctUsed: integer("waste_pct_used"),
  pitchTierApplied: text("pitch_tier_applied"),
  upsellSuggestions: jsonb("upsell_suggestions").$type<unknown[]>().default([]).notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  docusealSubmissionId: text("docuseal_submission_id"),
  // Cell 17b: the compliant SB38 template this signed contract was sent on (CO
  // paths); null when the jurisdiction is ungated.
  contractTemplateId: uuid("contract_template_id").references(() => contractTemplate.id),
  createdAt: createdAt(),
}, (t) => [index("estimate_tenant_job_idx").on(t.tenantId, t.jobId), tenantIsolation()]);

export const invoice = pgTable("invoice", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  jobId: uuid("job_id").notNull().references(() => job.id),
  customerId: uuid("customer_id").references(() => customer.id),
  number: text("number"),
  status: invoiceStatusEnum("status").notNull().default("draft"),
  lineItems: jsonb("line_items").$type<unknown[]>().default([]).notNull(),
  amountDue: integer("amount_due"),
  amountPaid: integer("amount_paid").default(0).notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }),
  stripeCheckoutSessionId: text("stripe_checkout_session_id"),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  stripeInvoiceId: text("stripe_invoice_id"),
  qboId: text("qbo_id"),
  createdAt: createdAt(),
}, (t) => [
  index("invoice_tenant_status_idx").on(t.tenantId, t.status),
  uniqueIndex("invoice_tenant_number_uniq").on(t.tenantId, t.number).where(sql`number IS NOT NULL`),
  tenantIsolation(),
]);

export const payment = pgTable("payment", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  invoiceId: uuid("invoice_id").notNull().references(() => invoice.id),
  method: paymentMethodEnum("method").notNull(),
  amount: integer("amount").notNull(),
  stripePaymentId: text("stripe_payment_id"),
  qboId: text("qbo_id"),
  receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("payment_tenant_invoice_idx").on(t.tenantId, t.invoiceId),
  uniqueIndex("payment_stripe_pmt_uniq").on(t.tenantId, t.stripePaymentId).where(sql`stripe_payment_id IS NOT NULL`),
  tenantIsolation(),
]);

export const commission = pgTable("commission", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  invoiceId: uuid("invoice_id").notNull().references(() => invoice.id),
  userId: uuid("user_id").notNull().references(() => user.id),
  model: commissionModelEnum("model").notNull(),
  basisCents: integer("basis_cents").notNull(),
  rate: integer("rate").notNull(),
  amountCents: integer("amount_cents").notNull(),
  periodKey: text("period_key").notNull(),
  status: commissionStatusEnum("status").notNull().default("pending"),
  createdAt: createdAt(),
}, (t) => [
  index("commission_tenant_user_idx").on(t.tenantId, t.userId),
  // Idempotency key: one commission per paid invoice. A redelivered invoice/paid
  // event hits this and is deduped (onConflictDoNothing) — never double-pays.
  uniqueIndex("commission_tenant_invoice_uniq").on(t.tenantId, t.invoiceId),
  tenantIsolation(),
]);

// Change orders (Phase 6C). A priced mid-production delta on a job, signed via
// DocuSeal. docusealSubmissionId is globally unique within the single Savvy
// instance; the (tenant, submission) unique index makes the webhook idempotent.
export const changeOrder = pgTable("change_order", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  jobId: uuid("job_id").notNull().references(() => job.id),
  customerId: uuid("customer_id").notNull().references(() => customer.id),
  reason: text("reason"),
  status: text("status").notNull().default("draft"), // draft|sent|approved|declined|voided
  lineItems: jsonb("line_items").$type<unknown[]>().default([]).notNull(),
  subtotal: integer("subtotal"),
  total: integer("total"),
  docusealSubmissionId: text("docuseal_submission_id"),
  signingUrl: text("signing_url"),
  invoiceId: uuid("invoice_id").references(() => invoice.id),
  applied: boolean("applied").notNull().default(false),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  index("change_order_tenant_job_idx").on(t.tenantId, t.jobId),
  uniqueIndex("change_order_submission_uniq").on(t.tenantId, t.docusealSubmissionId),
  tenantIsolation(),
]);
