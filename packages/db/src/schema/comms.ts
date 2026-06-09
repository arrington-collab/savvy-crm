import { pgTable, uuid, text, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls.js";
import { tenant, user } from "./tenancy.js";
import { customer } from "./crm.js";
import { job } from "./jobs.js";
import { commChannelEnum, commDirectionEnum } from "./enums.js";

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
