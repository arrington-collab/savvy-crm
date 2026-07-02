import { pgTable, uuid, text, integer, numeric, boolean, jsonb, timestamp, index, unique } from "drizzle-orm/pg-core";
import { idCol, createdAt, updatedAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";
import { job } from "./jobs";
import { lead } from "./crm";
import { agentRun } from "./agents";
import {
  taskOwnerEnum, taskModeEnum, taskScopeEnum, verificationTierEnum,
  jobTaskStatusEnum, evidenceStatusEnum, taskHealthStatusEnum,
} from "./enums";

/**
 * The Task Registry / Scoreboard (see docs/superpowers/specs/task-registry.md).
 * Turns the 212-task Master Task List into a live, evidence-verified registry so
 * the owner can run roofing companies headless: proof-of-execution, not screens.
 */

// Filter for which jobs a task applies to: job types + peril tags.
type AppliesTo = { job_types?: string[]; perils?: string[] };
// Evidence attached to a completed job_task instance.
type Evidence = { type: string; ref: string; url?: string };
// Refs (external ids, row ids) a verification run cites.
type EvidenceRef = { type: string; ref: string; url?: string };

/**
 * Global, versioned source of truth for all 212 tasks (edited only via seed
 * migrations, like the price book). `id` is the stable master task number 1–212.
 * No RLS — global read; savvy_app has SELECT via the standard table grants.
 */
export const taskRegistry = pgTable(
  "task_registry",
  {
    id: integer("id").primaryKey(), // master task number 1–212, stable forever
    slug: text("slug").notNull().unique(), // e.g. "lead.dedupe"
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    phase: integer("phase").notNull(), // 1–15
    defaultOwner: taskOwnerEnum("default_owner").notNull(),
    defaultMode: taskModeEnum("default_mode").notNull(),
    scope: taskScopeEnum("scope").notNull(),
    appliesTo: jsonb("applies_to").$type<AppliesTo>().notNull().default({}),
    dependsOn: integer("depends_on").array().notNull().default([]), // task-graph edges
    checkKey: text("check_key"), // key into the code-side evidence-check registry
    checkParams: jsonb("check_params").$type<Record<string, unknown>>().notNull().default({}),
    verificationTier: verificationTierEnum("verification_tier"),
    slaHours: integer("sla_hours"),
    estFounderMinutes: numeric("est_founder_minutes").notNull().default("0"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("task_registry_phase_idx").on(t.phase)],
);

/**
 * Per-tenant overrides on a registry task — how Alta (CO hail) and Bloom (AZ
 * wind/monsoon) diverge without forking the registry.
 */
export const tenantTaskConfig = pgTable(
  "tenant_task_config",
  {
    id: idCol(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    taskId: integer("task_id").notNull().references(() => taskRegistry.id),
    mode: taskModeEnum("mode"), // null = inherit registry default_mode
    enabled: boolean("enabled").notNull().default(true),
    params: jsonb("params").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("tenant_task_config_tenant_idx").on(t.tenantId),
    unique("tenant_task_config_uniq").on(t.tenantId, t.taskId),
    tenantIsolation(),
  ],
);

/**
 * The Job Ledger: per-job instantiation of a registry task. Ground truth Sage
 * cites for "is X done?" — answers cite these rows + evidence, never model memory.
 * `done` is claimed by the doer; `verified` is granted only by the health sweep.
 */
export const jobTask = pgTable(
  "job_task",
  {
    id: idCol(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    jobId: uuid("job_id").notNull().references(() => job.id, { onDelete: "cascade" }),
    taskId: integer("task_id").notNull().references(() => taskRegistry.id),
    status: jobTaskStatusEnum("status").notNull().default("pending"),
    owner: text("owner"), // agent name or user id at execution time
    evidence: jsonb("evidence").$type<Evidence>(),
    agentRunId: uuid("agent_run_id").references(() => agentRun.id), // command-center feed link
    blockedBy: integer("blocked_by").array().notNull().default([]), // computed from depends_on
    completedAt: timestamp("completed_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("job_task_tenant_job_idx").on(t.tenantId, t.jobId),
    unique("job_task_job_task_uniq").on(t.jobId, t.taskId),
    tenantIsolation(),
  ],
);

/**
 * The Lead Ledger: per-lead instantiation of a per_lead registry task (booking,
 * follow-up, scoring). Symmetric to job_task — leads run per_lead tasks the same
 * way jobs run per_job tasks; instance-level evidence for pre-job work.
 */
export const leadTask = pgTable(
  "lead_task",
  {
    id: idCol(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    leadId: uuid("lead_id").notNull().references(() => lead.id, { onDelete: "cascade" }),
    taskId: integer("task_id").notNull().references(() => taskRegistry.id),
    status: jobTaskStatusEnum("status").notNull().default("pending"),
    owner: text("owner"), // agent name or user id at execution time
    evidence: jsonb("evidence").$type<Evidence>(),
    agentRunId: uuid("agent_run_id").references(() => agentRun.id),
    blockedBy: integer("blocked_by").array().notNull().default([]), // computed from depends_on
    completedAt: timestamp("completed_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("lead_task_tenant_lead_idx").on(t.tenantId, t.leadId),
    unique("lead_task_lead_task_uniq").on(t.leadId, t.taskId),
    tenantIsolation(),
  ],
);

/**
 * History of evidence-check runs — feeds streak computation and debugging.
 * Pruned > 180d via the cold-archive pattern.
 */
export const verificationRun = pgTable(
  "verification_run",
  {
    id: idCol(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    taskId: integer("task_id").notNull().references(() => taskRegistry.id),
    checkKey: text("check_key").notNull(),
    status: evidenceStatusEnum("status").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    refs: jsonb("refs").$type<EvidenceRef[]>().notNull().default([]),
    ranAt: timestamp("ran_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("verification_run_tenant_task_idx").on(t.tenantId, t.taskId, t.ranAt),
    tenantIsolation(),
  ],
);

/**
 * The scoreboard: current health per (tenant, task). Status is earned from
 * streaks + verification recency, never declared. See spec for the exact rules.
 */
export const taskHealth = pgTable(
  "task_health",
  {
    id: idCol(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    taskId: integer("task_id").notNull().references(() => taskRegistry.id),
    status: taskHealthStatusEnum("status").notNull().default("gray"),
    effectiveMode: taskModeEnum("effective_mode").notNull(),
    cleanStreakDays: integer("clean_streak_days").notNull().default(0),
    lastExecutedAt: timestamp("last_executed_at", { withTimezone: true }),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    failCount7d: integer("fail_count_7d").notNull().default(0),
    openExceptionCount: integer("open_exception_count").notNull().default(0),
    founderMinutes30d: numeric("founder_minutes_30d").notNull().default("0"),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("task_health_tenant_idx").on(t.tenantId),
    unique("task_health_uniq").on(t.tenantId, t.taskId),
    tenantIsolation(),
  ],
);

/**
 * Per-tenant portfolio snapshot (one row per tenant, upserted by the sweep).
 * Coverage = full_auto tasks proven green out of the whole task list — the
 * "empire coverage" metric — plus the status breakdown and 30d ops rates.
 */
export const tenantOpsRollup = pgTable(
  "tenant_ops_rollup",
  {
    id: idCol(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    fullAutoGreen: integer("full_auto_green").notNull().default(0), // coverage numerator
    totalTasks: integer("total_tasks").notNull().default(0), // coverage denominator (212)
    greenCount: integer("green_count").notNull().default(0),
    amberCount: integer("amber_count").notNull().default(0),
    redCount: integer("red_count").notNull().default(0),
    openExceptionCount: integer("open_exception_count").notNull().default(0),
    jobs30d: integer("jobs_30d").notNull().default(0), // exceptions-per-job denominator
    founderMinutes30d: numeric("founder_minutes_30d").notNull().default("0"),
    computedAt: timestamp("computed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("tenant_ops_rollup_tenant_uniq").on(t.tenantId),
    tenantIsolation(),
  ],
);
