import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, jsonb, index, uniqueIndex, timestamp, boolean, type AnyPgColumn } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant, user } from "./tenancy";
import { customer, property, lead } from "./crm";
import { job } from "./jobs";
import { estimate } from "./finance";

// The Roof Record (spec: docs/superpowers/specs/prompts-roof-record.md).
// Zone-first inspection capture: the inspector SELECTS the zone before shooting;
// grades are earned from findings+photos (an ACTION grade is impossible without
// a linked finding carrying a photo — enforced in lifecycle, tested red-path).

export const inspection = pgTable("inspection", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  // Inspections are lead-scoped pre-sale (same shape as lead-stage appointments);
  // job_id is set for post-sale/warranty inspections.
  leadId: uuid("lead_id").references(() => lead.id),
  jobId: uuid("job_id").references(() => job.id),
  propertyId: uuid("property_id").notNull().references(() => property.id),
  inspectorUserId: uuid("inspector_user_id").references(() => user.id),
  kind: text("kind").notNull().default("initial"), // initial|post_storm|re_inspection|warranty
  status: text("status").notNull().default("in_progress"), // in_progress|pending_approval|approved|published
  // Links re-inspections to the Record they are compared against.
  baselineInspectionId: uuid("baseline_inspection_id").references((): AnyPgColumn => inspection.id),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  index("inspection_tenant_lead_idx").on(t.tenantId, t.leadId),
  index("inspection_tenant_property_idx").on(t.tenantId, t.propertyId),
  index("inspection_tenant_status_idx").on(t.tenantId, t.status),
  tenantIsolation(),
]);

export const inspectionZone = pgTable("inspection_zone", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  inspectionId: uuid("inspection_id").notNull().references(() => inspection.id),
  // Stable key: facet id from measurement geometry when available, else a named
  // zone ("ground_front"). Media ingestion upserts zones by (inspection_id, zone_key).
  zoneKey: text("zone_key").notNull(),
  zoneLabel: text("zone_label").notNull(),
  zoneKind: text("zone_kind").notNull().default("other"), // ground|facet|valley|ridge|penetrations|gutters|attic|other
  sortOrder: integer("sort_order").notNull().default(0),
  grade: text("grade"), // good|monitor|action — null until the inspector's on-site call
  gradeSetByUserId: uuid("grade_set_by_user_id").references(() => user.id),
  // Audit trail: which checklist version drove this zone's capture.
  checklistVersionRef: text("checklist_version_ref"),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("inspection_zone_key_uniq").on(t.inspectionId, t.zoneKey),
  index("inspection_zone_tenant_inspection_idx").on(t.tenantId, t.inspectionId),
  tenantIsolation(),
]);

export const inspectionFinding = pgTable("inspection_finding", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  inspectionZoneId: uuid("inspection_zone_id").notNull().references(() => inspectionZone.id),
  checklistItemKey: text("checklist_item_key"), // null for free-form findings
  severitySuggested: text("severity_suggested"), // from the checklist item's maps_to_finding template
  whatItIs: text("what_it_is").notNull(),
  ifIgnored: text("if_ignored"),
  timeframe: text("timeframe"), // plain English, rubric-constrained
  // document ids; ≥1 REQUIRED when the zone grade is ACTION (lifecycle-enforced).
  photoIds: jsonb("photo_ids").$type<string[]>().default([]).notNull(),
  disposition: text("disposition").notNull().default("noted"), // noted|fixed_free_today|repair_quoted|replacement_factor
  repairEstimateCents: integer("repair_estimate_cents"),
  createdBy: text("created_by").notNull().default("inspector"), // inspector|ai_suggested — ai_suggested requires inspector confirmation before publish
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  index("inspection_finding_tenant_zone_idx").on(t.tenantId, t.inspectionZoneId),
  tenantIsolation(),
]);

// Library-versioned checklists, per zone_kind. Revisions are config, not code:
// a new version is a new row; zones stamp checklist_version_ref at capture.
export const inspectionChecklist = pgTable("inspection_checklist", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  key: text("key").notNull(),
  version: integer("version").notNull().default(1),
  zoneKind: text("zone_kind").notNull().default("other"),
  name: text("name").notNull(),
  // items[]: { key, prompt, input: pass_fail|count|measure|photo_required|note,
  //            maps_to_finding: { what_it_is, if_ignored, timeframe, severity } | null,
  //            friend_rule_eligible: boolean }
  items: jsonb("items").$type<unknown[]>().default([]).notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("inspection_checklist_key_version_uniq").on(t.tenantId, t.key, t.version),
  tenantIsolation(),
]);

// Paid repairs sourced from an inspection mint a 36-month replacement credit
// (slice 2 wires issuance/auto-apply/cadence; the table ships in the one migration).
export const repairCredit = pgTable("repair_credit", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  customerId: uuid("customer_id").notNull().references(() => customer.id),
  sourceInspectionId: uuid("source_inspection_id").references(() => inspection.id),
  sourceInvoiceRef: text("source_invoice_ref"),
  amountCents: integer("amount_cents").notNull(),
  issuedAt: timestamp("issued_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  status: text("status").notNull().default("active"), // active|applied|expired|opted_out
  appliedEstimateId: uuid("applied_estimate_id").references(() => estimate.id),
  // Check-in cadence log: [{ at, kind: '12mo'|'24mo'|'33mo', commId }]
  checkinLog: jsonb("checkin_log").$type<unknown[]>().default([]).notNull(),
  createdAt: createdAt(),
}, (t) => [
  index("repair_credit_tenant_customer_idx").on(t.tenantId, t.customerId),
  index("repair_credit_tenant_status_idx").on(t.tenantId, t.status),
  tenantIsolation(),
]);

// Media events can replay (BloomCam's outbox retries); this maps an external
// photo event onto its zone exactly once per (inspection, external photo).
export const inspectionMedia = pgTable("inspection_media", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  inspectionId: uuid("inspection_id").notNull().references(() => inspection.id),
  inspectionZoneId: uuid("inspection_zone_id").notNull().references(() => inspectionZone.id),
  documentId: uuid("document_id").notNull(),
  checklistItemKey: text("checklist_item_key"),
  capturedAt: timestamp("captured_at", { withTimezone: true }),
  // GPS is a sanity check ONLY (3-5m accuracy cannot place photos per-facet);
  // never used for zone placement.
  gpsLat: text("gps_lat"),
  gpsLng: text("gps_lng"),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("inspection_media_document_uniq").on(t.inspectionId, t.documentId),
  index("inspection_media_tenant_zone_idx").on(t.tenantId, t.inspectionZoneId),
  tenantIsolation(),
]);
