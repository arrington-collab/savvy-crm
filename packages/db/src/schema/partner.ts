import { pgTable, uuid, text, integer, boolean, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant, user } from "./tenancy";

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
  // Slice 3 — grades produce CARDS, never cutoffs. Recomputed monthly per
  // tenant TZ (partner.grades_current evidence); A flips schedulingPriority,
  // a FRESH C opens a pending decision card a human resolves.
  grade: text("grade"), // A|B|C, null until first recompute
  gradedAt: timestamp("graded_at", { withTimezone: true }),
  schedulingPriority: boolean("scheduling_priority").notNull().default(false),
  slackCapacityOnly: boolean("slack_capacity_only").notNull().default(false),
  cCardStatus: text("c_card_status"), // pending|resolved
  cCardResolution: text("c_card_resolution"), // conversation|slack_capacity_only|dismissed
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

// Slice 2 — the ledger itself. Every accrual is a row with an idempotency
// source_ref (inspection:{id}, finding:{id}, referral_payment:{id},
// expense:{uuid}); the unique index makes replays free. direction covers
// slice 4's cert REVENUE without a reshape. This is operational economics,
// not accounting — QuickBooks stays the books.
export const partnerLedgerEntry = pgTable("partner_ledger_entry", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  partnerId: uuid("partner_id").notNull().references(() => partner.id),
  kind: text("kind").notNull(), // inspection_standard|free_repair|referral_fee|cert_cost|expense
  direction: text("direction").notNull().default("cost"), // cost|revenue
  amountCents: integer("amount_cents").notNull(),
  sourceRef: text("source_ref").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  note: text("note"),
  createdByUserId: uuid("created_by_user_id").references(() => user.id),
  createdAt: createdAt(),
}, (t) => [
  index("partner_ledger_tenant_partner_idx").on(t.tenantId, t.partnerId),
  index("partner_ledger_tenant_kind_idx").on(t.tenantId, t.kind),
  uniqueIndex("partner_ledger_source_ref_uq").on(t.tenantId, t.sourceRef),
  tenantIsolation(),
]);
