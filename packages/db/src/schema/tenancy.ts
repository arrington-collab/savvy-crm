import { pgTable, uuid, text, jsonb, index, timestamp, uniqueIndex, doublePrecision } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { userRoleEnum } from "./enums";

// Root of isolation. NOTE: tenant itself has no tenant_id; it is gated by
// Clerk org lookup, not RLS. clerk_org_id/public_key/inbound_phone are
// extensions beyond DATA-MODEL.md (approved).
export const tenant = pgTable("tenant", {
  id: idCol(),
  name: text("name").notNull(),
  revenueBand: text("revenue_band"),
  planPrice: text("plan_price"),
  clerkOrgId: text("clerk_org_id").unique(),
  publicKey: text("public_key").unique(),
  inboundPhone: text("inbound_phone"),
  stripeAccountId: text("stripe_account_id"),
  qboConnectionId: text("qbo_connection_id"),
  companycamConnectionId: text("companycam_connection_id"),
  settings: jsonb("settings").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: createdAt(),
});

export const user = pgTable("user", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  clerkUserId: text("clerk_user_id"),
  name: text("name").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  role: userRoleEnum("role").notNull().default("rep"),
  gcalConnectionId: text("gcal_connection_id"),
  baseLat: doublePrecision("base_lat"),
  baseLng: doublePrecision("base_lng"),
  skills: text("skills").array().notNull().default([]),
  pinHash: text("pin_hash"),
  deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  index("user_tenant_idx").on(t.tenantId),
  tenantIsolation(),
  uniqueIndex("user_tenant_clerk_uniq").on(t.tenantId, t.clerkUserId).where(sql`${t.clerkUserId} IS NOT NULL`),
]);
