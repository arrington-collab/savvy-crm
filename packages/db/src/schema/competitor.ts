import { pgTable, uuid, text, index, uniqueIndex } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";

// Phase 26 slice 4 (#349): competitors are PICKED (typeahead, create-once) —
// the same folding hygiene as partners, or the market-pricing artifact
// fragments into "Peak Roofing / peak roofing / Peak Roofing LLC".
export const competitor = pgTable("competitor", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  name: text("name").notNull(),
  normalizedKey: text("normalized_key").notNull(),
  createdAt: createdAt(),
}, (t) => [
  index("competitor_tenant_idx").on(t.tenantId),
  uniqueIndex("competitor_tenant_key_uq").on(t.tenantId, t.normalizedKey),
  tenantIsolation(),
]);
