import { pgTable, uuid, text, boolean, doublePrecision, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";
import { property } from "./crm";

// Strike List slice 2 (#265/#266) — Roof Tagger ground-truth pins. The tagger
// (bloomroofs.vercel.app) is a separate app where a human taps a roof on the
// map and records its material. A pull sync lands each pin here, matches it to
// a property (nearest known roof), and upgrades property.roof_material with
// source='spotter'. precisionScore is the spotter's rolling accuracy vs
// inspection ground truth (#266). One row per (tenant, external_id) — re-syncs
// update in place.
export const spotterPin = pgTable("spotter_pin", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  externalId: text("external_id").notNull(), // the tagger app's pin id
  lat: doublePrecision("lat").notNull(),
  lng: doublePrecision("lng").notNull(),
  materialTag: text("material_tag"), // a ROOF_MATERIAL_VALUES string the spotter chose
  hasDebris: boolean("has_debris").notNull().default(false),
  spotterName: text("spotter_name"),
  taggedAt: timestamp("tagged_at", { withTimezone: true }),
  syncedAt: timestamp("synced_at", { withTimezone: true }),
  matchedPropertyId: uuid("matched_property_id").references(() => property.id),
  precisionScore: doublePrecision("precision_score"),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("spotter_pin_tenant_external_uq").on(t.tenantId, t.externalId),
  index("spotter_pin_tenant_property_idx").on(t.tenantId, t.matchedPropertyId),
  tenantIsolation(),
]);
