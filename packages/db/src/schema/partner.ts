import { pgTable, uuid, text, index, uniqueIndex } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";

// Partner Ledger slice 1 (spec: docs/superpowers/specs/prompts-partner-ledger.md).
// Referral partners (realtors, insurance agents, property managers) are PICKED
// (typeahead, create-once), never free-typed. normalized_key — partnerKey() in
// @savvy/core (folded name|org) — is the create-once identity within a tenant.
export const partner = pgTable("partner", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  name: text("name").notNull(),
  org: text("org"),
  class: text("class").notNull().default("other"), // realtor|insurance_agent|property_manager|other
  phone: text("phone"),
  email: text("email"),
  status: text("status").notNull().default("active"), // active|paused|archived
  notes: text("notes"),
  normalizedKey: text("normalized_key").notNull(),
  createdAt: createdAt(),
}, (t) => [
  index("partner_tenant_idx").on(t.tenantId),
  uniqueIndex("partner_tenant_key_uq").on(t.tenantId, t.normalizedKey),
  tenantIsolation(),
]);

// Proposed merges surfaced by backfill/create-once when the same folded NAME
// appears at different orgs. Humans resolve via the review card; the machine
// NEVER silently merges distinct people.
export const partnerMergeCandidate = pgTable("partner_merge_candidate", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  partnerAId: uuid("partner_a_id").notNull().references(() => partner.id),
  partnerBId: uuid("partner_b_id").notNull().references(() => partner.id),
  reason: text("reason").notNull(),
  status: text("status").notNull().default("pending"), // pending|merged|kept_separate
  createdAt: createdAt(),
}, (t) => [
  index("partner_merge_tenant_status_idx").on(t.tenantId, t.status),
  uniqueIndex("partner_merge_pair_uq").on(t.tenantId, t.partnerAId, t.partnerBId),
  tenantIsolation(),
]);
