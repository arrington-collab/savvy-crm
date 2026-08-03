import { pgTable, uuid, text, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";

// The generic migration ledger. Every entity created by a bulk importer
// records its source external id here, so re-runs are idempotent and every
// migrated row can be traced back to the raw source record (payload keeps
// the original verbatim — the audit trail lives here instead of polluting
// hot tables with vendor columns).
export const importRecord = pgTable("import_record", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  source: text("source").notNull(), // importer source id
  externalId: text("external_id").notNull(), // source GUID, prefixed per entity (e.g. 'job:<guid>')
  entityType: text("entity_type").notNull(), // customer|property|lead|job
  entityId: uuid("entity_id").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("import_record_source_uq").on(t.tenantId, t.source, t.externalId),
  index("import_record_entity_idx").on(t.tenantId, t.entityType, t.entityId),
  tenantIsolation(),
]);
