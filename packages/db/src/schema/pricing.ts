import { pgTable, uuid, text, integer, boolean, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";
import { priceBookCategoryEnum, priceBookUnitEnum } from "./enums";

// Versioning spine: price changes are NEVER in-place — every apply mints a new
// version and clones items under it. Sent estimates stamp their version (30-day
// price lock); new drafts read the current version.
export const priceBookVersion = pgTable("price_book_version", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  versionNo: integer("version_no").notNull(),
  source: text("source").notNull().default("manual"), // manual | ai_parse | drift
  note: text("note"),
  current: boolean("current").notNull().default(false),
  createdAt: createdAt(),
}, (t) => [
  index("price_book_version_tenant_idx").on(t.tenantId),
  uniqueIndex("price_book_version_no_uniq").on(t.tenantId, t.versionNo),
  tenantIsolation(),
]);

export const priceBookItem = pgTable("price_book_item", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  // null versionId = the pre-versioning live book; treated as current until the
  // first applyPriceBookVersion bootstraps version 1.
  versionId: uuid("version_id").references(() => priceBookVersion.id),
  key: text("key").notNull(),
  name: text("name").notNull(),
  category: priceBookCategoryEnum("category").notNull(),
  unit: priceBookUnitEnum("unit").notNull(),
  unitPriceCents: integer("unit_price_cents").notNull().default(0),
  unitCostCents: integer("unit_cost_cents").notNull().default(0),
  sourceFields: jsonb("source_fields").$type<string[]>().default([]).notNull(),
  wasteApplies: boolean("waste_applies").notNull().default(false),
  packSize: integer("pack_size").notNull().default(1),
  // Quantity formula beyond the plain sourceFields sum: sum | ice_water | disposal | fixed.
  qtyFormula: text("qty_formula"),
  // Per-item margin floor override (bps); null = tenant default floor.
  marginFloorBps: integer("margin_floor_bps"),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: createdAt(),
}, (t) => [
  index("price_book_tenant_idx").on(t.tenantId),
  // Live (pre-versioning) items keep the original per-tenant key uniqueness;
  // versioned clones are unique per version instead.
  uniqueIndex("price_book_tenant_key_uniq").on(t.tenantId, t.key).where(sql`version_id is null`),
  uniqueIndex("price_book_version_key_uniq").on(t.versionId, t.key).where(sql`version_id is not null`),
  tenantIsolation(),
]);

// The Good/Better/Best shingle products (owner decisions: IKO Cambridge / IKO
// Dynasty (recommended) / TAMKO Titan XT). Costs/prices are OWNER-FILLED slots —
// null means "price book needs costs" (we never invent).
export const tierProduct = pgTable("tier_product", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  tier: text("tier").notNull(), // good | better | best
  productName: text("product_name").notNull(),
  manufacturer: text("manufacturer").notNull(),
  unitPriceCents: integer("unit_price_cents"), // per square; null = unpriced
  unitCostCents: integer("unit_cost_cents"), // per square; null = cost unknown
  warrantyText: text("warranty_text").notNull().default(""),
  warrantyRegistration: text("warranty_registration"),
  recommended: boolean("recommended").notNull().default(false),
  colorPalette: jsonb("color_palette").$type<{ name: string; hex: string }[]>().default([]).notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
}, (t) => [
  index("tier_product_tenant_idx").on(t.tenantId),
  uniqueIndex("tier_product_tenant_tier_uniq").on(t.tenantId, t.tier),
  tenantIsolation(),
]);
