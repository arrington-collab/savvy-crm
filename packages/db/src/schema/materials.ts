import { pgTable, uuid, text, integer, doublePrecision, jsonb, boolean, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant, user } from "./tenancy";
import { job } from "./jobs";
import { document } from "./ops";
import { creditRequest } from "./credit-request";

// Phase 26 slice 3 — material reconciliation + returns (#347/#348).

// Leftover stock counted at job end. source 'manual' is the entry card;
// 'photo_parse' is the crew-EOD leftover-photo upgrade path (parse pipeline
// deferred — the column is ready for it). One row per (job, item), corrections
// overwrite.
export const materialLeftover = pgTable("material_leftover", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  jobId: uuid("job_id").notNull().references(() => job.id),
  itemKey: text("item_key").notNull(),
  name: text("name"),
  quantity: doublePrecision("quantity").notNull(),
  unit: text("unit"),
  source: text("source").notNull().default("manual"), // manual|photo_parse
  documentId: uuid("document_id").references(() => document.id),
  createdByUserId: uuid("created_by_user_id").references(() => user.id),
  createdAt: createdAt(),
}, (t) => [
  index("material_leftover_tenant_job_idx").on(t.tenantId, t.jobId),
  uniqueIndex("material_leftover_job_item_uq").on(t.tenantId, t.jobId, t.itemKey),
  tenantIsolation(),
]);

// The reconciliation snapshot: ordered vs invoiced vs used per job. flagged =
// some line's variance beat the threshold (feeds the waste-factor review).
// leftoversConfirmedAt records the crew's explicit "nothing left over".
export const materialReconciliation = pgTable("material_reconciliation", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  jobId: uuid("job_id").notNull().references(() => job.id),
  lines: jsonb("lines").$type<unknown[]>().default([]).notNull(),
  flagged: boolean("flagged").notNull().default(false),
  leftoversConfirmedAt: timestamp("leftovers_confirmed_at", { withTimezone: true }),
  computedAt: timestamp("computed_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("material_reconciliation_job_uq").on(t.tenantId, t.jobId),
  tenantIsolation(),
]);

// A returnable leftover becomes a return/pickup task with an expected credit,
// chased via the price-guard credit machinery. materials.returns_resolved
// invariant: nothing sits unresolved past the return window.
export const materialReturn = pgTable("material_return", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  jobId: uuid("job_id").notNull().references(() => job.id),
  itemKey: text("item_key").notNull(),
  name: text("name"),
  quantity: doublePrecision("quantity").notNull(),
  expectedCreditCents: integer("expected_credit_cents").notNull().default(0),
  recoveredCents: integer("recovered_cents").notNull().default(0),
  status: text("status").notNull().default("pending_pickup"), // pending_pickup|credited|written_off
  creditRequestId: uuid("credit_request_id").references(() => creditRequest.id),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  index("material_return_tenant_status_idx").on(t.tenantId, t.status),
  uniqueIndex("material_return_job_item_uq").on(t.tenantId, t.jobId, t.itemKey),
  tenantIsolation(),
]);
