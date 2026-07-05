import { pgTable, uuid, text, uniqueIndex } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";

// Opt-in per-tenant supplier recipient allow-list (13c auto-send hardening). When a
// tenant has ≥1 row, price-guard auto-send only emails a recipient whose domain is
// listed; empty = no restriction. Manual delete removes a domain (no soft-delete).
export const supplierAllowlist = pgTable("supplier_allowlist", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  domain: text("domain").notNull(),
  label: text("label"),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("supplier_allowlist_tenant_domain_uniq").on(t.tenantId, t.domain),
  tenantIsolation(),
]);
