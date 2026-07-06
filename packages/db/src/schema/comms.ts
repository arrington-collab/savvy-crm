import { pgTable, uuid, text, boolean, integer, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { idCol, createdAt, updatedAt, tenantIsolation } from "./_rls";
import { tenant, user } from "./tenancy";
import { customer, lead, property } from "./crm";
import { job } from "./jobs";
import { crew } from "./crew";
import { commChannelEnum, commDirectionEnum, messageChannelEnum, dripStatusEnum, dripStopReasonEnum, appointmentTypeEnum, appointmentStatusEnum } from "./enums";
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
  deliveryStatus: text("delivery_status"),      // raw Twilio MessageStatus of the last receipt
  deliveryErrorCode: text("delivery_error_code"), // Twilio ErrorCode on failed/undelivered (e.g. 30007)
  aiHandled: boolean("ai_handled").default(false).notNull(),
  durationSeconds: integer("duration_seconds"),
  dedupeKey: text("dedupe_key"),
  createdAt: createdAt(),
}, (t) => [
  index("comm_tenant_job_idx").on(t.tenantId, t.jobId),
  uniqueIndex("communication_dedupe_uniq").on(t.tenantId, t.dedupeKey).where(sql`dedupe_key is not null`),
  tenantIsolation(),
]);

export const appointment = pgTable("appointment", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  // Slice 1 (leads-stage overhaul): an inspection is booked against the LEAD
  // before a job exists. job_id is null for lead-stage inspections and is set for
  // crew/install appointments (which happen after the job is created). lead_id +
  // property_id scope lead-stage appointments; property_id drives the license check.
  jobId: uuid("job_id").references(() => job.id),
  leadId: uuid("lead_id").references(() => lead.id),
  propertyId: uuid("property_id").references(() => property.id),
  customerId: uuid("customer_id").references(() => customer.id),
  type: appointmentTypeEnum("type").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  assigneeUserId: uuid("assignee_user_id").references(() => user.id),
  // For type='crew' installs the appointment is assigned to a crew (team)
  // instead of a single user. assigneeUserId is null in that case.
  crewId: uuid("crew_id").references(() => crew.id),
  status: appointmentStatusEnum("status").notNull().default("scheduled"),
  gcalEventId: text("gcal_event_id"),
  weatherNote: text("weather_note"),
  weatherFlaggedAt: timestamp("weather_flagged_at", { withTimezone: true }),
  createdAt: createdAt(),
  // NOTE: two Postgres EXCLUDE constraints enforce no overlapping 'scheduled'
  // appts — appointment_no_overlap (per assignee_user_id, migration 0003) and
  // appointment_crew_no_overlap (per crew_id, migration 0032). Both are added
  // by hand (drizzle-kit can't express EXCLUDE).
}, (t) => [
  index("appt_tenant_job_idx").on(t.tenantId, t.jobId),
  index("appt_tenant_crew_idx").on(t.tenantId, t.crewId),
  tenantIsolation(),
]);

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
}, (t) => [uniqueIndex("msg_tmpl_tenant_key_idx").on(t.tenantId, t.key), tenantIsolation()]);

export const drip = pgTable("drip", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  key: text("key").notNull(),
  name: text("name").notNull(),
  triggerEvent: text("trigger_event"),
  steps: jsonb("steps").$type<DripStep[]>().notNull().default(sql`'[]'::jsonb`),
  active: boolean("active").default(true).notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("drip_tenant_key_idx").on(t.tenantId, t.key), tenantIsolation()]);

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
  enrolledAt: timestamp("enrolled_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (t) => [
  index("drip_enr_tenant_customer_idx").on(t.tenantId, t.customerId),
  index("drip_enr_tenant_status_idx").on(t.tenantId, t.status),
  uniqueIndex("drip_enr_active_uniq").on(t.dripId, t.customerId).where(sql`status = 'active'`),
  tenantIsolation(),
]);
