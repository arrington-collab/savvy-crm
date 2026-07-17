import { pgTable, uuid, text, integer, doublePrecision, boolean, index, jsonb, timestamp, date } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant, user } from "./tenancy";
import { partner } from "./partner";
import { leadStatusEnum, stormCertStatusEnum } from "./enums";

export const customer = pgTable("customer", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  // Homeowner updates render in the customer's language when set ('en'|'es').
  preferredLanguage: text("preferred_language"),
  // Customer for Life: print-channel opt-out (sms/email opt-outs already exist).
  mailOptOut: boolean("mail_opt_out").notNull().default(false),
  // Customer for Life: no relationship touches while a claim dispute is active.
  claimDisputeHold: boolean("claim_dispute_hold").notNull().default(false),
  // Customer for Life slice 3: set only by a CONFIRMED move_event (threshold or human).
  movedAt: timestamp("moved_at", { withTimezone: true }),
  newAddress: text("new_address"),
  name: text("name").notNull(),
  email: text("email"),
  phone: text("phone"),
  billingAddress: text("billing_address"),
  smsOptOut: boolean("sms_opt_out").default(false).notNull(),
  emailOptOut: boolean("email_opt_out").default(false).notNull(),
  smsConsentAt: timestamp("sms_consent_at", { withTimezone: true }),
  // Phase 26 slice 2: explicit opt-IN for using this customer's job (photos,
  // "we're roofing here" creative) in marketing. Null = never reference them.
  marketingConsentAt: timestamp("marketing_consent_at", { withTimezone: true }),
  // Provenance of the email: "self_reported" (homeowner gave it — usable for
  // marketing) vs "appended" (data-broker skip-trace — transactional-only).
  emailSource: text("email_source"),
  qboId: text("qbo_id"),
  createdAt: createdAt(),
}, (t) => [index("customer_tenant_idx").on(t.tenantId), tenantIsolation()]);

export const property = pgTable("property", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  customerId: uuid("customer_id").references(() => customer.id),
  address: text("address").notNull(),
  city: text("city"),
  line1: text("line1"),
  state: text("state"),
  zip: text("zip"),
  county: text("county"),
  roofType: text("roof_type"),
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  parcelId: text("parcel_id"),
  roofSqft: integer("roof_sqft"),
  roofPitch: text("roof_pitch"),
  yearBuilt: integer("year_built"),
  roofTypeSecondary: text("roof_type_secondary"),
  lastRoofReplacementAt: date("last_roof_replacement_at"),
  lastRoofReplacementSource: text("last_roof_replacement_source"),
  stories: integer("stories"),
  notes: text("notes"),
  // Roof Record baseline: set on the property's FIRST published Record. Plain
  // uuid (no .references()) — inspection.ts imports property, so a column-level
  // FK here would be a circular import; the lifecycle write is the integrity gate.
  baselineInspectionId: uuid("baseline_inspection_id"),
  baselineAt: timestamp("baseline_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index("property_tenant_idx").on(t.tenantId), tenantIsolation()]);

export const lead = pgTable("lead", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  customerId: uuid("customer_id").references(() => customer.id),
  propertyId: uuid("property_id").references(() => property.id),
  source: text("source"),
  sourceDetail: jsonb("source_detail"),
  // Partner Ledger: attribution FK — partner-class sources (realtor/
  // insurance_agent/partner) must carry this (partner.attribution invariant).
  partnerId: uuid("partner_id").references(() => partner.id),
  // Phase 26 slice 4 (#349): OPTIONAL win/loss price intel — captured on the
  // lost flow when reason='price'; never required, never blocks the close.
  lostReason: text("lost_reason"), // price|timing|went_dark|not_interested|other
  lostAt: timestamp("lost_at", { withTimezone: true }),
  competitorBidCents: integer("competitor_bid_cents"),
  competitorId: uuid("competitor_id"),
  status: leadStatusEnum("status").notNull().default("new"),
  stormCertStatus: stormCertStatusEnum("storm_cert_status").notNull().default("pending"),
  stormCheckedAt: timestamp("storm_checked_at", { withTimezone: true }),
  stormCertDocumentId: uuid("storm_cert_document_id"),
  score: integer("score"),
  scoreReason: text("score_reason"),
  scoreFeatures: jsonb("score_features"),
  scoreBand: text("score_band"),
  lane: text("lane"),
  firstRepContactAt: timestamp("first_rep_contact_at", { withTimezone: true }),
  voiceOutcome: text("voice_outcome"),
  voiceCallId: text("voice_call_id"),
  installRecommendation: jsonb("install_recommendation"),
  stormEventId: text("storm_event_id"),
  assignedUserId: uuid("assigned_user_id").references(() => user.id),
  createdAt: createdAt(),
}, (t) => [
  index("lead_tenant_status_idx").on(t.tenantId, t.status),
  index("lead_voice_call_id_idx").on(t.tenantId, t.voiceCallId),
  tenantIsolation(),
]);

export const leadNote = pgTable("lead_note", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  leadId: uuid("lead_id").notNull().references(() => lead.id),
  authorUserId: uuid("author_user_id").references(() => user.id),
  body: text("body").notNull(),
  createdAt: createdAt(),
}, (t) => [index("lead_note_tenant_lead_idx").on(t.tenantId, t.leadId), tenantIsolation()]);
