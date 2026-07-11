import { pgTable, uuid, text, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant, user } from "./tenancy";
import { job } from "./jobs";
import { lead } from "./crm";
import { agentEnum } from "./enums";

export const agentRun = pgTable("agent_run", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  agent: agentEnum("agent").notNull(),
  jobId: uuid("job_id").references(() => job.id),
  // Lead-stage runs (no job yet) link here so the command-center feed can show
  // the customer name via lead → customer, the same way job runs do via job.
  leadId: uuid("lead_id").references(() => lead.id),
  taskKey: text("task_key"),
  inngestRunId: text("inngest_run_id"),
  status: text("status").notNull().default("running"), // running|ok|error
  modelUsed: text("model_used"),
  tokens: integer("tokens"),
  costCents: integer("cost_cents"),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  error: text("error"),
}, (t) => [
  index("agent_run_tenant_idx").on(t.tenantId),
  index("agent_run_started_idx").on(t.tenantId, t.startedAt.desc()),
  index("agent_run_job_idx").on(t.jobId),
  index("agent_run_lead_idx").on(t.leadId),
  index("agent_run_status_idx").on(t.status),
  tenantIsolation(),
]);

export const auditLog = pgTable("audit_log", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  userId: uuid("user_id").references(() => user.id),
  agent: agentEnum("agent"),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  action: text("action").notNull(),
  diff: jsonb("diff").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: createdAt(),
}, (t) => [index("audit_tenant_idx").on(t.tenantId), tenantIsolation()]);
