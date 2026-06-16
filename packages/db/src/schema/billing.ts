import { pgTable, uuid, text, integer, bigint, index, uniqueIndex } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";

export const usageSnapshot = pgTable("usage_snapshot", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  periodKey: text("period_key").notNull(), // YYYY-MM
  jobsProcessed: integer("jobs_processed").notNull().default(0),
  aiSpendCents: integer("ai_spend_cents").notNull().default(0),
  aiVoiceMinutes: integer("ai_voice_minutes").notNull().default(0),
  storageBytes: bigint("storage_bytes", { mode: "number" }).notNull().default(0),
  bandKey: text("band_key").notNull(),
  basePriceCents: integer("base_price_cents").notNull().default(0),
  overageCents: integer("overage_cents").notNull().default(0),
  totalCents: integer("total_cents").notNull().default(0),
  createdAt: createdAt(),
}, (t) => [
  index("usage_snapshot_tenant_idx").on(t.tenantId),
  uniqueIndex("usage_snapshot_tenant_period_uniq").on(t.tenantId, t.periodKey),
  tenantIsolation(),
]);
