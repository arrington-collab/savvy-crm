import { pgTable, uuid, text, integer, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";

// Append-only audit log of every event the orchestrator processed. One row per
// (event, subscriber-outcome). `idempotency_key` carries a UNIQUE index scoped
// per tenant so a double-publish across instances cannot double-process — the
// DB is the real dedupe backstop behind the engine's in-memory check.
export const orchestratorEvent = pgTable("orchestrator_event", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  eventId: text("event_id").notNull(),
  eventType: text("event_type").notNull(),
  version: integer("version").notNull().default(1),
  source: text("source").notNull(),
  correlationId: text("correlation_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  actor: text("actor"),
  agent: text("agent").notNull(),
  outcome: text("outcome").notNull(), // received|handled|dead_letter
  emitted: jsonb("emitted").$type<string[]>().default([]).notNull(),
  error: text("error"),
  payload: jsonb("payload").$type<Record<string, unknown>>(),
  createdAt: createdAt(),
}, (t) => [
  index("orchestrator_event_corr_idx").on(t.tenantId, t.correlationId),
  index("orchestrator_event_created_idx").on(t.tenantId, t.createdAt),
  // Dedupe backstop: an idempotencyKey processes at most once per tenant. Only
  // the "received" audit row (the one that claims the key) participates in
  // the constraint — handled/dead_letter rows are one-per-subscriber and must
  // not be constrained by it.
  uniqueIndex("orchestrator_event_idem_uq")
    .on(t.tenantId, t.idempotencyKey)
    .where(sql`outcome = 'received'`),
  tenantIsolation(),
]);

export const orchestratorEscalation = pgTable("orchestrator_escalation", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  ruleId: text("rule_id").notNull(),
  severity: text("severity").notNull(), // low|medium|high
  reason: text("reason").notNull(),
  notify: jsonb("notify").$type<string[]>().default([]).notNull(),
  eventId: text("event_id").notNull(),
  eventType: text("event_type").notNull(),
  correlationId: text("correlation_id").notNull(),
  status: text("status").notNull().default("open"), // open|resolved
  createdAt: createdAt(),
}, (t) => [
  index("orchestrator_escalation_open_idx").on(t.tenantId, t.status),
  tenantIsolation(),
]);
