import { pgTable, uuid, text, integer, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { idCol, createdAt, updatedAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";
import { telephonyProviderEnum, integrationStatusEnum } from "./enums";

// Per-tenant third-party integration credentials. Secrets are AES-256-GCM
// sealed (see @savvy/core secret-box); only ciphertext lives in the DB.
export const integrationConnection = pgTable("integration_connection", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  provider: telephonyProviderEnum("provider").notNull(),
  status: integrationStatusEnum("status").notNull().default("pending"),
  secretCiphertext: text("secret_ciphertext").notNull(),
  secretIv: text("secret_iv").notNull(),
  secretTag: text("secret_tag").notNull(),
  keyVersion: integer("key_version").notNull().default(1),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
  label: text("label"),
  lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index("integration_connection_tenant_idx").on(t.tenantId),
  uniqueIndex("integration_connection_tenant_provider_uniq").on(t.tenantId, t.provider),
  tenantIsolation(),
]);
