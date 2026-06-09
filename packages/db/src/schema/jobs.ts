import { pgTable, uuid, text, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls.js";
import { tenant, user } from "./tenancy.js";
import { customer, property, lead } from "./crm.js";
import { jobTypeEnum, jobStageEnum, taskStatusEnum, automationLevelEnum, agentEnum } from "./enums.js";

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
  openedAt: timestamp("opened_at", { withTimezone: true }).defaultNow().notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  stageEnteredAt: timestamp("stage_entered_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: createdAt(),
}, (t) => [
  index("job_tenant_stage_idx").on(t.tenantId, t.stage),
  tenantIsolation(),
]);

export const jobTask = pgTable("job_task", {
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
  assigneeUserId: uuid("assignee_user_id").references(() => user.id),
  payload: jsonb("payload").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: createdAt(),
}, (t) => [
  index("job_task_tenant_job_idx").on(t.tenantId, t.jobId),
  tenantIsolation(),
]);
