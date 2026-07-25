import { pgTable, uuid, text, jsonb, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";

// One projected row per (tenant, business_date). Upserted; rebuildable from the log.
export const dailyMetrics = pgTable("daily_metrics", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  businessDate: text("business_date").notNull(), // YYYY-MM-DD Denver
  metrics: jsonb("metrics").$type<Record<string, unknown>>().notNull(),
  generatedAt: timestamp("generated_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("daily_metrics_date_uq").on(t.tenantId, t.businessDate),
  tenantIsolation(),
]);

// Stateful layer over orchestrator_escalation. Unique per (tenant, escalation_key) = idempotent intake.
export const exceptionQueue = pgTable("exception_queue", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  escalationKey: text("escalation_key").notNull(), // `${ruleId}:${eventId}`
  ruleId: text("rule_id").notNull(),
  eventId: text("event_id").notNull(),
  severity: text("severity").notNull(),
  reason: text("reason").notNull(),
  notify: jsonb("notify").$type<string[]>().default([]).notNull(),
  assignee: text("assignee").notNull(),
  state: text("state").notNull().default("open"), // open|acknowledged|resolved|snoozed
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolutionNote: text("resolution_note"),
  snoozeUntil: timestamp("snooze_until", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("exception_queue_key_uq").on(t.tenantId, t.escalationKey),
  index("exception_queue_state_idx").on(t.tenantId, t.state),
  tenantIsolation(),
]);
