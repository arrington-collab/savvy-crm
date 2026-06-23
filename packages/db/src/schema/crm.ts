import { pgTable, uuid, text, integer, doublePrecision, boolean, index, jsonb } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant, user } from "./tenancy";
import { leadStatusEnum } from "./enums";

export const customer = pgTable("customer", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  name: text("name").notNull(),
  email: text("email"),
  phone: text("phone"),
  billingAddress: text("billing_address"),
  smsOptOut: boolean("sms_opt_out").default(false).notNull(),
  emailOptOut: boolean("email_opt_out").default(false).notNull(),
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
  stories: integer("stories"),
  notes: text("notes"),
  createdAt: createdAt(),
}, (t) => [index("property_tenant_idx").on(t.tenantId), tenantIsolation()]);

export const lead = pgTable("lead", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  customerId: uuid("customer_id").references(() => customer.id),
  propertyId: uuid("property_id").references(() => property.id),
  source: text("source"),
  status: leadStatusEnum("status").notNull().default("new"),
  score: integer("score"),
  scoreReason: text("score_reason"),
  scoreFeatures: jsonb("score_features"),
  installRecommendation: jsonb("install_recommendation"),
  stormEventId: text("storm_event_id"),
  assignedUserId: uuid("assigned_user_id").references(() => user.id),
  createdAt: createdAt(),
}, (t) => [
  index("lead_tenant_status_idx").on(t.tenantId, t.status),
  tenantIsolation(),
]);
