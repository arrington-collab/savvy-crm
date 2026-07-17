import { pgTable, uuid, text, integer, doublePrecision, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { idCol, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";

// Owner's Room slice 1 — monthly valuation snapshot history. One row per
// tenant per period (YYYY-MM); insufficient-data months are STORED with null
// values (the honesty trail shows when the data wasn't there), never faked.
export const valuationSnapshot = pgTable("valuation_snapshot", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  periodKey: text("period_key").notNull(), // YYYY-MM in the tenant's TZ
  status: text("status").notNull(), // ok | insufficient_data
  reasons: jsonb("reasons").$type<string[]>(),
  sdeCents: integer("sde_cents"),
  valueLowCents: integer("value_low_cents"),
  valueLikelyCents: integer("value_likely_cents"),
  valueHighCents: integer("value_high_cents"),
  multipleLow: doublePrecision("multiple_low"),
  multipleHigh: doublePrecision("multiple_high"),
  // The full named-adjustment ledger + per-input quality flags + raw inputs —
  // the methodology page renders straight from these.
  adjustments: jsonb("adjustments").$type<unknown[]>().default([]).notNull(),
  inputQuality: jsonb("input_quality").$type<Record<string, unknown>>(),
  inputs: jsonb("inputs").$type<Record<string, unknown>>(),
  methodologyVersion: text("methodology_version").notNull(),
  computedAt: timestamp("computed_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("valuation_snapshot_tenant_idx").on(t.tenantId),
  uniqueIndex("valuation_snapshot_period_uq").on(t.tenantId, t.periodKey),
  tenantIsolation(),
]);
