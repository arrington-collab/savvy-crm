import { pgTable, uuid, text, boolean, integer, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { idCol, createdAt, updatedAt, tenantIsolation } from "./_rls";
import { tenant, user } from "./tenancy";
import { customer, lead } from "./crm";
import { job } from "./jobs";
import { commChannelEnum, commDirectionEnum, messageChannelEnum, dripStatusEnum, dripStopReasonEnum } from "./enums";
import type { DripStep } from "@savvy/core";

export const communication = pgTable("communication", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  jobId: uuid("job_id").references(() => job.id),
  customerId: uuid("customer_id").references(() => customer.id),
  channel: commChannelEnum("channel").notNull(),
  direction: commDirectionEnum("direction").notNull(),
  to: text("to"),
  from: text("from"),
  body: text("body"),
  recordingUrl: text("recording_url"),
  transcript: text("transcript"),
  twilioSid: text("twilio_sid"),
  aiHandled: boolean("ai_handled").default(false).notNull(),
  createdAt: createdAt(),
}, (t) => [index("comm_tenant_job_idx").on(t.tenantId, t.jobId), tenantIsolation()]);

export const appointment = pgTable("appointment", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  jobId: uuid("job_id").notNull().references(() => job.id),
  type: text("type").notNull(), // inspection | crew | cm
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  assigneeUserId: uuid("assignee_user_id").references(() => user.id),
  status: text("status").notNull().default("scheduled"), // scheduled|done|canceled|no_show
  gcalEventId: text("gcal_event_id"),
  createdAt: createdAt(),
}, (t) => [index("appt_tenant_job_idx").on(t.tenantId, t.jobId), tenantIsolation()]);

export const messageTemplate = pgTable("message_template", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  key: text("key").notNull(),
  name: text("name").notNull(),
  channel: messageChannelEnum("channel").notNull(),
  subject: text("subject"),
  body: text("body").notNull(),
  aiCapability: text("ai_capability"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("msg_tmpl_tenant_key_idx").on(t.tenantId, t.key), tenantIsolation()]);

export const drip = pgTable("drip", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  key: text("key").notNull(),
  name: text("name").notNull(),
  triggerEvent: text("trigger_event"),
  steps: jsonb("steps").$type<DripStep[]>().notNull().default(sql`'[]'::jsonb`),
  active: boolean("active").default(true).notNull(),
  createdAt: createdAt(),
}, (t) => [index("drip_tenant_key_idx").on(t.tenantId, t.key), tenantIsolation()]);

export const dripEnrollment = pgTable("drip_enrollment", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  dripId: uuid("drip_id").notNull().references(() => drip.id),
  customerId: uuid("customer_id").notNull().references(() => customer.id),
  jobId: uuid("job_id").references(() => job.id),
  leadId: uuid("lead_id").references(() => lead.id),
  status: dripStatusEnum("status").notNull().default("active"),
  currentStep: integer("current_step").notNull().default(0),
  stoppedReason: dripStopReasonEnum("stopped_reason"),
  inngestRunId: text("inngest_run_id"),
  enrolledAt: createdAt(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (t) => [
  index("drip_enr_tenant_customer_idx").on(t.tenantId, t.customerId),
  index("drip_enr_tenant_status_idx").on(t.tenantId, t.status),
  uniqueIndex("drip_enr_active_uniq").on(t.dripId, t.customerId).where(sql`status = 'active'`),
  tenantIsolation(),
]);
