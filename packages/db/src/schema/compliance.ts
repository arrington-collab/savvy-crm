import { pgTable, uuid, text, integer, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { idCol, createdAt, updatedAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";

// Per-tenant, per-jurisdiction license matrix (Cell 17a). city NULL = state-level
// license (e.g. AZ ROC covers all AZ cities); city set = municipal registration
// (Denver, Aurora). The scheduling block invariant (bookAppointment) refuses to
// schedule in a jurisdiction with no active license row here.
export const license = pgTable("license", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  state: text("state").notNull(),
  city: text("city"),
  authority: text("authority").notNull(),
  licenseNumber: text("license_number").notNull(),
  status: text("status").notNull(), // active | pending | expired | suspended
  issuedAt: timestamp("issued_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index("license_tenant_state_city_idx").on(t.tenantId, t.state, t.city),
  tenantIsolation(),
]);

// Per-tenant, per-jurisdiction contract-template registry (Cell 17b, SB38). A CO
// template is compliant when status='active' and its clauses cover the SB38 set
// (right_to_rescind, no_deductible_waiver, ten_day). docuseal_template_id is a
// nullable placeholder — the real legal template (owner/lawyer authored) attaches
// later. Both signed-contract paths (estimate e-sign + canvass field contract)
// stamp the resolved template id; the nightly compliance.contract_template
// invariant catches drift (a once-compliant template later retired).
export const contractTemplate = pgTable("contract_template", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  state: text("state").notNull(),
  version: integer("version").notNull(),
  name: text("name").notNull(),
  docusealTemplateId: text("docuseal_template_id"),
  clauses: jsonb("clauses").notNull().default([]),
  status: text("status").notNull(), // active | draft | retired
  effectiveAt: timestamp("effective_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex("contract_template_tenant_state_version_idx").on(t.tenantId, t.state, t.version),
  tenantIsolation(),
]);
