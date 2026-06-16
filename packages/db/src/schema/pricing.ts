import { pgTable, uuid, text, integer, boolean, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";
import { priceBookCategoryEnum, priceBookUnitEnum } from "./enums";

export const priceBookItem = pgTable("price_book_item", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  key: text("key").notNull(),
  name: text("name").notNull(),
  category: priceBookCategoryEnum("category").notNull(),
  unit: priceBookUnitEnum("unit").notNull(),
  unitPriceCents: integer("unit_price_cents").notNull().default(0),
  sourceFields: jsonb("source_fields").$type<string[]>().default([]).notNull(),
  wasteApplies: boolean("waste_applies").notNull().default(false),
  packSize: integer("pack_size").notNull().default(1),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: createdAt(),
}, (t) => [
  index("price_book_tenant_idx").on(t.tenantId),
  uniqueIndex("price_book_tenant_key_uniq").on(t.tenantId, t.key),
  tenantIsolation(),
]);
