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
