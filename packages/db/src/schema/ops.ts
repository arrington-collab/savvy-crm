import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, jsonb, index, timestamp, uniqueIndex, doublePrecision } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant, user } from "./tenancy";
import { customer, property, lead } from "./crm";
import { job } from "./jobs";
import { contractTemplate } from "./compliance";

export const document = pgTable("document", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  jobId: uuid("job_id").references(() => job.id),
  customerId: uuid("customer_id").references(() => customer.id),
  kind: text("kind").notNull(), // photo|measurement|contract|lien_waiver|cert|evidence|other|insurance_estimate|measurement_report
  label: text("label"),
  // Slice 6a: lead-stage scope + uploader + parse lifecycle (parsing lands in 6b/6c).
  leadId: uuid("lead_id").references(() => lead.id),
  propertyId: uuid("property_id").references(() => property.id),
  uploadedByUserId: uuid("uploaded_by_user_id").references(() => user.id),
  parseStatus: text("parse_status").notNull().default("pending"), // pending|parsed|parse_failed|unparsed_low_confidence
  parseConfidence: doublePrecision("parse_confidence"),
  r2Key: text("r2_key"),
  filename: text("filename"),
  mime: text("mime"),
  sizeBytes: integer("size_bytes"),
  source: text("source").default("upload"), // companycam|savvy|upload
  externalUrl: text("external_url"),                 // CompanyCam-hosted URL (source='companycam')
  companycamPhotoId: text("companycam_photo_id"),    // dedupe key for the CompanyCam webhook
  sitesnapPhotoId: text("sitesnap_photo_id"),          // dedupe key for the SiteSnap webhook
  captureAddress: text("capture_address"),             // raw address from the producer (for unmatched re-match)
  phash: text("phash"),                                // perceptual hash (Slice 2 dedup)
  qcStatus: text("qc_status").default("pending"),      // pending|passed|flagged|skipped
  qcReasons: jsonb("qc_reasons").$type<unknown>(),     // structured QC reasons (Slice 2)
  sharedWith: jsonb("shared_with").$type<unknown[]>().default([]).notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  // Cell 17b: the compliant SB38 template a signed contract document (kind='contract')
  // was stored on (CO canvass paths); null when the jurisdiction is ungated.
  contractTemplateId: uuid("contract_template_id").references(() => contractTemplate.id),
  createdAt: createdAt(),
}, (t) => [
  index("document_tenant_job_idx").on(t.tenantId, t.jobId),
  index("document_tenant_lead_idx").on(t.tenantId, t.leadId),
  uniqueIndex("document_tenant_sitesnap_uniq").on(t.tenantId, t.sitesnapPhotoId).where(sql`${t.sitesnapPhotoId} is not null`),
  tenantIsolation(),
]);

export const measurement = pgTable("measurement", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  propertyId: uuid("property_id").notNull().references(() => property.id),
  provider: text("provider").default("roofr"),   // "roofr" | "diy"
  source: text("source"), // ordered|uploaded_report|sketch (orthogonal to provider; 6b)
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

export const crewCheckin = pgTable("crew_checkin", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  jobId: uuid("job_id").notNull().references(() => job.id),
  // Production Pulse: which CREW checked in (the day belongs to a crew, not
  // just one member) — silence/late-crew detection keys on this.
  crewId: uuid("crew_id"),
  crewUserId: uuid("crew_user_id").notNull().references(() => user.id),
  checkedInAt: timestamp("checked_in_at", { withTimezone: true }).defaultNow().notNull(),
  checkInLat: doublePrecision("check_in_lat"),
  checkInLng: doublePrecision("check_in_lng"),
  checkedOutAt: timestamp("checked_out_at", { withTimezone: true }),
  checkOutLat: doublePrecision("check_out_lat"),
  checkOutLng: doublePrecision("check_out_lng"),
  createdAt: createdAt(),
}, (t) => [index("crew_checkin_tenant_job_idx").on(t.tenantId, t.jobId), tenantIsolation()]);
