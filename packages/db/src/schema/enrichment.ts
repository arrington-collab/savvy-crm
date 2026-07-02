import { pgTable, uuid, text, integer, timestamp, index, unique } from "drizzle-orm/pg-core";
import { idCol, createdAt, updatedAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";

/**
 * One row per (entity, enricher) enrichment attempt. The background sweep uses it
 * to converge without re-hammering external APIs: an enricher's findDue skips
 * entities whose ledger row has too many attempts or was tried too recently.
 * Generic (entity_type/entity_id, like audit_log) so every enricher reuses it.
 */
export const enrichmentAttempt = pgTable(
  "enrichment_attempt",
  {
    id: idCol(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    entityType: text("entity_type").notNull(), // "property" | "customer" | "lead"
    entityId: uuid("entity_id").notNull(),
    enricherKey: text("enricher_key").notNull(), // "geocode" | "property-stormproof"
    status: text("status").notNull(), // filled | no_data | error
    attempts: integer("attempts").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    detail: text("detail"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("enrichment_attempt_tenant_idx").on(t.tenantId),
    unique("enrichment_attempt_uniq").on(t.tenantId, t.entityType, t.entityId, t.enricherKey),
    tenantIsolation(),
  ],
);
