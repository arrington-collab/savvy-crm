import { pgTable, uuid, text, integer, bigint, real, boolean, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";
import type { DailyMetrics } from "@savvy/command-center";

// Day 4 EOS weekly scorecard — 5 sibling tables over daily_metrics.
// ALL ADDITIVE: daily_metrics and exception_queue (command-center.ts) are
// frozen and never reshaped by this file. Column names are chosen to match
// packages/command-center/src/weekly-metrics.ts (D4-1) 1:1 so the two stay
// aligned without a translation layer.

// One `(tenant, date, locationId, repId)` row, folded from orchestrator_event.
// Backs DailyMetricsByRep.
export const dailyMetricsByRep = pgTable("daily_metrics_by_rep", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  businessDate: text("business_date").notNull(), // YYYY-MM-DD Denver
  locationId: uuid("location_id"),
  repId: uuid("rep_id").notNull(),
  leads: integer("leads").notNull(),
  firstTouches: integer("first_touches").notNull(),
  medianSpeedSeconds: integer("median_speed_seconds"),
  apptsSet: integer("appts_set").notNull(),
  noShows: integer("no_shows").notNull(),
  contracts: integer("contracts").notNull(),
  contractValueCents: bigint("contract_value_cents", { mode: "number" }).notNull(),
  estimatesApproved: integer("estimates_approved").notNull(),
  avgMarginPct: real("avg_margin_pct"),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("daily_metrics_by_rep_uq").on(t.tenantId, t.businessDate, t.locationId, t.repId),
  tenantIsolation(),
]);

// One `(tenant, date, locationId, source)` row. Backs DailyMetricsBySource.
export const dailyMetricsBySource = pgTable("daily_metrics_by_source", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  businessDate: text("business_date").notNull(),
  locationId: uuid("location_id"),
  source: text("source").notNull(),
  leads: integer("leads").notNull(),
  apptsSet: integer("appts_set").notNull(),
  contracts: integer("contracts").notNull(),
  contractValueCents: bigint("contract_value_cents", { mode: "number" }).notNull(),
  costCents: bigint("cost_cents", { mode: "number" }),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("daily_metrics_by_source_uq").on(t.tenantId, t.businessDate, t.locationId, t.source),
  tenantIsolation(),
]);

// One `(tenant, date, locationId)` row carrying the same DailyMetrics blob
// shape as daily_metrics, scoped to a single location. Backs DailyMetricsByLocation.
export const dailyMetricsByLocation = pgTable("daily_metrics_by_location", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  businessDate: text("business_date").notNull(),
  locationId: uuid("location_id"),
  metrics: jsonb("metrics").$type<DailyMetrics>().notNull(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("daily_metrics_by_location_uq").on(t.tenantId, t.businessDate, t.locationId),
  tenantIsolation(),
]);

// One `(weekStart, tenantId, locationId, metricKey)` row — a single frozen
// metric for one week, with its 13-week trailing history. Backs WeeklyMetrics.
export const weeklyScorecard = pgTable("weekly_scorecard", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  weekStart: text("week_start").notNull(), // Monday YYYY-MM-DD, Denver
  locationId: uuid("location_id"), // null = company-wide rollup
  metricKey: text("metric_key").notNull(),
  value: jsonb("value").$type<number | null>(),
  goal: jsonb("goal").$type<number | null>(),
  onTrack: boolean("on_track"),
  priorWeeks: jsonb("prior_weeks").$type<(number | null)[]>().notNull(), // oldest->newest, 13 entries incl. current week
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("weekly_scorecard_uq").on(t.tenantId, t.weekStart, t.locationId, t.metricKey),
  tenantIsolation(),
]);

// Per-(tenant, location, metric) goal/target used to compute onTrack.
export const scorecardGoal = pgTable("scorecard_goal", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  locationId: uuid("location_id"), // null = company-wide
  metricKey: text("metric_key").notNull(),
  target: real("target").notNull(),
  direction: text("direction").notNull(), // 'gte' | 'lte'
  isPlaceholder: boolean("is_placeholder").default(true).notNull(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("scorecard_goal_uq").on(t.tenantId, t.locationId, t.metricKey),
  tenantIsolation(),
]);
