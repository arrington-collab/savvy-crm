import { pgTable, uuid, text, integer, jsonb, index, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant, user } from "./tenancy";
import { customer, property } from "./crm";
import { job } from "./jobs";

export const document = pgTable("document", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  jobId: uuid("job_id").references(() => job.id),
  customerId: uuid("customer_id").references(() => customer.id),
  kind: text("kind").notNull(), // photo|measurement|contract|lien_waiver|cert|evidence|other
  label: text("label"),
  r2Key: text("r2_key").notNull(),
  filename: text("filename"),
  mime: text("mime"),
  sizeBytes: integer("size_bytes"),
  source: text("source").default("upload"), // companycam|savvy|upload
  sharedWith: jsonb("shared_with").$type<unknown[]>().default([]).notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index("document_tenant_job_idx").on(t.tenantId, t.jobId), tenantIsolation()]);

export const measurement = pgTable("measurement", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  propertyId: uuid("property_id").notNull().references(() => property.id),
  provider: text("provider").default("roofr"),
  reportUrl: text("report_url"),
  areas: jsonb("areas").$type<Record<string, unknown>>().default({}).notNull(),
  pitch: text("pitch"),
  orderedByUserId: uuid("ordered_by_user_id").references(() => user.id),
  costCents: integer("cost_cents"),
  createdAt: createdAt(),
}, (t) => [index("measurement_tenant_idx").on(t.tenantId), tenantIsolation()]);

// E-sign requests (Phase 6B). One row per lien-waiver/cert signature request.
// docusealSubmissionId is globally unique within the single Savvy DocuSeal instance;
// the (tenant, submission) unique index makes the webhook idempotent.
export const esignRequest = pgTable("esign_request", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  jobId: uuid("job_id").notNull().references(() => job.id),
  customerId: uuid("customer_id").notNull().references(() => customer.id),
  docType: text("doc_type").notNull(), // lien_waiver|cert
  templateId: text("template_id").notNull(),
  docusealSubmissionId: text("docuseal_submission_id").notNull(),
  status: text("status").notNull().default("draft"), // draft|sent|completed|declined|voided
  signingUrl: text("signing_url"),
  documentId: uuid("document_id").references(() => document.id),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  index("esign_request_tenant_job_idx").on(t.tenantId, t.jobId),
  uniqueIndex("esign_request_submission_uniq").on(t.tenantId, t.docusealSubmissionId),
  tenantIsolation(),
]);
