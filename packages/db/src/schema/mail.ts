import { pgTable, uuid, text, integer, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant, user } from "./tenancy";
import { property } from "./crm";
import { job } from "./jobs";

// Direct-mail data model — shapes from the PostGrid spec (docs/superpowers/
// specs/prompts-postgrid.md) so the eventual PostGrid build slots in without
// a reshape. Phase 26 slice 1 (mobilization blitz) creates these DORMANT:
// pieces hold as print_pending until a print provider is connected — the same
// seam pattern as the Customer for Life holiday cards.
export const mailCampaign = pgTable("mail_campaign", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  kind: text("kind").notNull(), // mobilization_blitz|storm_event|claim_deadline|neighbor_radius|permit_watch|resurrection|adhoc
  triggerRef: text("trigger_ref"), // e.g. the job id that scheduled the blitz
  jobId: uuid("job_id").references(() => job.id), // job-attributed marketing spend
  audienceCount: integer("audience_count").notNull().default(0),
  estCostCents: integer("est_cost_cents").notNull().default(0),
  status: text("status").notNull().default("pending_approval"), // pending_approval|approved|cancelled
  approvedByUserId: uuid("approved_by_user_id").references(() => user.id),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  index("mail_campaign_tenant_kind_idx").on(t.tenantId, t.kind),
  uniqueIndex("mail_campaign_kind_trigger_uq").on(t.tenantId, t.kind, t.triggerRef),
  tenantIsolation(),
]);

export const mailPiece = pgTable("mail_piece", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  campaignId: uuid("campaign_id").notNull().references(() => mailCampaign.id),
  propertyId: uuid("property_id").references(() => property.id),
  // Address snapshot at plan time — the 60d suppression invariant keys on it,
  // and the audience may eventually include parcels that aren't property rows.
  addressText: text("address_text").notNull(),
  type: text("type").notNull().default("postcard"), // postcard|letter
  wave: integer("wave").notNull().default(1),
  templateKey: text("template_key").notNull(),
  mergeVars: jsonb("merge_vars").$type<Record<string, unknown>>().default({}).notNull(),
  // Arrive-WINDOW targeting, never promised exact days (USPS reality).
  mailByDate: timestamp("mail_by_date", { withTimezone: true }).notNull(),
  arriveWindowStart: timestamp("arrive_window_start", { withTimezone: true }).notNull(),
  arriveWindowEnd: timestamp("arrive_window_end", { withTimezone: true }).notNull(),
  costCents: integer("cost_cents").notNull().default(0),
  // print_pending until a print provider wakes the seam; then the PostGrid
  // lifecycle (draft…delivered_est|returned|failed|cancelled) takes over.
  status: text("status").notNull().default("print_pending"),
  postgridId: text("postgrid_id"),
  createdAt: createdAt(),
  statusUpdatedAt: timestamp("status_updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("mail_piece_tenant_campaign_idx").on(t.tenantId, t.campaignId),
  index("mail_piece_tenant_status_idx").on(t.tenantId, t.status),
  uniqueIndex("mail_piece_campaign_target_wave_uq").on(t.tenantId, t.campaignId, t.propertyId, t.wave),
  tenantIsolation(),
]);
