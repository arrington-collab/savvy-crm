import { pgTable, uuid, text, integer, jsonb, index, uniqueIndex, timestamp, boolean, doublePrecision } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";
import { job } from "./jobs";
import { crew } from "./crew";

// Production Pulse (spec: docs/superpowers/specs/prompts-production-pulse.md).
// Phases are to jobs what Roof Record zones are to inspections: crews document
// through BloomCam, EVIDENCE advances phases (never status buttons), the
// homeowner hears narrated progress with photos, the office hears exceptions only.

// Library-versioned phase templates per job type — revisions are new version
// rows, never code edits. items[] = PhaseTemplateItem (see @savvy/core).
export const productionPhaseTemplate = pgTable("production_phase_template", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  jobType: text("job_type").notNull(), // retail|insurance|repair
  version: integer("version").notNull().default(1),
  items: jsonb("items").$type<unknown[]>().default([]).notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("production_phase_template_uniq").on(t.tenantId, t.jobType, t.version),
  tenantIsolation(),
]);

export const productionPhase = pgTable("production_phase", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  jobId: uuid("job_id").notNull().references(() => job.id),
  phaseKey: text("phase_key").notNull(),
  label: text("label").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  status: text("status").notNull().default("pending"), // pending|in_progress|done|verified
  customerVisible: boolean("customer_visible").notNull().default(true),
  // Template default, overridable per job (pace-lag detection reads this).
  expectedDurationHours: doublePrecision("expected_duration_hours").notNull().default(2),
  // Slice 3 municipal gate: this phase cannot START until a PASSED
  // municipal_inspection record with this key exists for the job.
  requiredInspectionKey: text("required_inspection_key"),
  templateVersionRef: text("template_version_ref"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  evidencePhotoIds: jsonb("evidence_photo_ids").$type<string[]>().default([]).notNull(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("production_phase_job_key_uniq").on(t.jobId, t.phaseKey),
  index("production_phase_tenant_job_idx").on(t.tenantId, t.jobId),
  index("production_phase_tenant_status_idx").on(t.tenantId, t.status),
  tenantIsolation(),
]);

// Phase-tagged media events (BloomCam production mode): replay-safe via the
// (job_id, document_id) unique link — the same dedupe shape as inspection_media.
// A NULL phase_id row is the TRIAGE state: photo arrived with unknown phase
// context — held for the triage card, never silently dropped (red path).
export const productionMedia = pgTable("production_media", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  jobId: uuid("job_id").notNull().references(() => job.id),
  productionPhaseId: uuid("production_phase_id").references(() => productionPhase.id),
  phaseKeyRaw: text("phase_key_raw"), // what the capture claimed (kept for triage)
  documentId: uuid("document_id").notNull(),
  shot: text("shot"), // capture-context shot kind ('deck', 'magnet_sweep', …)
  crewId: uuid("crew_id").references(() => crew.id),
  crewMemberName: text("crew_member_name"),
  capturedAt: timestamp("captured_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("production_media_document_uniq").on(t.jobId, t.documentId),
  index("production_media_tenant_phase_idx").on(t.tenantId, t.productionPhaseId),
  tenantIsolation(),
]);

// Slice 2: the homeowner-update ledger. EVERY send (or logged suppression)
// lands here — production.ho_updates / production.delivery_notice evidence
// read this table, and the max-N/day throttle counts it.
export const productionUpdate = pgTable("production_update", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  jobId: uuid("job_id").notNull().references(() => job.id),
  // phase_complete|delivery_3day|delivery_eve|eod_wrap
  kind: text("kind").notNull(),
  phaseKey: text("phase_key"),
  body: text("body"),
  photoIds: jsonb("photo_ids").$type<string[]>().default([]).notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  suppressedReason: text("suppressed_reason"), // quiet_hours|throttle|no_phone|opt_out|no_safe_photos|demo_mute
  createdAt: createdAt(),
}, (t) => [
  index("production_update_tenant_job_idx").on(t.tenantId, t.jobId, t.kind),
  index("production_update_tenant_sent_idx").on(t.tenantId, t.sentAt),
  tenantIsolation(),
]);

// Crew end-of-day report: REQUIRED to close the crew day (a missing report by
// cutoff is an office exception — slice 3's detector). Sources the homeowner
// evening wrap ("here's where we left it; tomorrow: ridge caps and cleanup").
export const crewEodReport = pgTable("crew_eod_report", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  jobId: uuid("job_id").notNull().references(() => job.id),
  crewId: uuid("crew_id").references(() => crew.id),
  // The calendar day this report closes (tenant-local, yyyy-mm-dd) — one per job-day.
  dayKey: text("day_key").notNull(),
  whatGotDone: text("what_got_done").notNull(),
  blockers: jsonb("blockers").$type<unknown[]>().default([]).notNull(),
  tomorrowPlan: text("tomorrow_plan"),
  source: text("source").notNull().default("form"), // form|voice
  reportedByName: text("reported_by_name"),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("crew_eod_job_day_uniq").on(t.jobId, t.dayKey),
  index("crew_eod_tenant_day_idx").on(t.tenantId, t.dayKey),
  tenantIsolation(),
]);

// Slice 3: crew-flagged blockers — the ONLY way routine field reality reaches
// the office is as one of these cards (material short, weather call, homeowner
// issue, hidden damage). hidden_damage auto-drafts a change-order stub.
export const productionBlocker = pgTable("production_blocker", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  jobId: uuid("job_id").notNull().references(() => job.id),
  phaseKey: text("phase_key"),
  kind: text("kind").notNull(), // material_short|weather|homeowner_issue|hidden_damage|other
  note: text("note"),
  photoIds: jsonb("photo_ids").$type<string[]>().default([]).notNull(),
  reportedByName: text("reported_by_name"),
  status: text("status").notNull().default("open"), // open|resolved
  changeOrderId: uuid("change_order_id"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  index("production_blocker_tenant_status_idx").on(t.tenantId, t.status),
  tenantIsolation(),
]);

// Municipal inspection records: jurisdiction-gated phases (e.g. dry-in
// inspection before install in some CO cities) cannot START until a passed
// record exists. Scheduling/result capture is a card-driven office task.
export const municipalInspection = pgTable("municipal_inspection", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  jobId: uuid("job_id").notNull().references(() => job.id),
  inspectionKey: text("inspection_key").notNull(), // e.g. 'dry_in'
  status: text("status").notNull().default("pending"), // pending|passed|failed
  recordedAt: timestamp("recorded_at", { withTimezone: true }),
  note: text("note"),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("municipal_inspection_job_key_uniq").on(t.jobId, t.inspectionKey),
  tenantIsolation(),
]);
