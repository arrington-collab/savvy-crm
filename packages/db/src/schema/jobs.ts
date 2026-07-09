import { pgTable, uuid, text, integer, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant, user } from "./tenancy";
import { customer, property, lead } from "./crm";
import { jobTypeEnum, jobStageEnum, taskStatusEnum, automationLevelEnum, agentEnum } from "./enums";

export const job = pgTable("job", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  customerId: uuid("customer_id").notNull().references(() => customer.id),
  propertyId: uuid("property_id").notNull().references(() => property.id),
  type: jobTypeEnum("type").notNull().default("retail"),
  stage: jobStageEnum("stage").notNull().default("lead"),
  valueEstimate: integer("value_estimate"),
  valueFinal: integer("value_final"),
  assignedUserId: uuid("assigned_user_id").references(() => user.id),
  leadId: uuid("lead_id").references(() => lead.id),
  companycamProjectId: text("companycam_project_id"),
  costCents: integer("cost_cents"),
  // Cell 11 financing seam (retail only). Neutral application status — never any
  // credit data. Default 'none'; a provider webhook advances it. financing_ref is
  // the vendor's opaque application id.
  financingStatus: text("financing_status").notNull().default("none"),
  financingRef: text("financing_ref"),
  openedAt: timestamp("opened_at", { withTimezone: true }).defaultNow().notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  stageEnteredAt: timestamp("stage_entered_at", { withTimezone: true }).defaultNow().notNull(),
  // Canvass door-sale: production/material are held until this instant (statutory rescission
  // window, computed from signedAt in tenant tz). Null = no hold. Auto-releases passively.
  rescissionHoldUntil: timestamp("rescission_hold_until", { withTimezone: true }),
  // Denormalized canvass rep name (canvass_rep is not a Clerk user) for commission attribution.
  canvassRepName: text("canvass_rep_name"),
  createdAt: createdAt(),
}, (t) => [
  index("job_tenant_stage_idx").on(t.tenantId, t.stage),
  tenantIsolation(),
  uniqueIndex("job_companycam_project_uniq").on(t.companycamProjectId).where(sql`${t.companycamProjectId} IS NOT NULL`),
]);

// Ad-hoc per-job checklist items (key/title/status). NOTE: renamed from the
// original "job_task" table — that name now belongs to the Task Registry's
// per-job task instances (see schema/task-registry.ts). This is the
// operational checklist, not the registry.
export const jobChecklistItem = pgTable("job_checklist_item", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  jobId: uuid("job_id").notNull().references(() => job.id),
  key: text("key").notNull(),
  title: text("title").notNull(),
  phase: text("phase"),
  ownerAgent: agentEnum("owner_agent"),
  automationLevel: automationLevelEnum("automation_level").default("manual"),
  status: taskStatusEnum("status").notNull().default("pending"),
  dueAt: timestamp("due_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  deferredAt: timestamp("deferred_at", { withTimezone: true }),
  assigneeUserId: uuid("assignee_user_id").references(() => user.id),
  payload: jsonb("payload").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: createdAt(),
}, (t) => [
  index("job_checklist_item_tenant_job_idx").on(t.tenantId, t.jobId),
  tenantIsolation(),
]);

export const jobStageEvent = pgTable("job_stage_event", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  jobId: uuid("job_id").notNull().references(() => job.id),
  fromStage: jobStageEnum("from_stage"),
  toStage: jobStageEnum("to_stage").notNull(),
  enteredAt: timestamp("entered_at", { withTimezone: true }).defaultNow().notNull(),
  homeownerNotifiedAt: timestamp("homeowner_notified_at", { withTimezone: true }),
  byUserId: uuid("by_user_id").references(() => user.id),
  byAgent: agentEnum("by_agent"),
  note: text("note"),
}, (t) => [
  index("job_stage_event_tenant_job_idx").on(t.tenantId, t.jobId, t.enteredAt),
  tenantIsolation(),
]);
