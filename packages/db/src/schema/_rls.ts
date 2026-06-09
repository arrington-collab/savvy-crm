import { pgPolicy, uuid, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";

// Reusable id + timestamp columns. uuid v7 generated app-side (sortable).
export const idCol = () => uuid("id").primaryKey().$defaultFn(() => uuidv7());
export const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
export const updatedAt = () => timestamp("updated_at", { withTimezone: true }).defaultNow().notNull();

// The one policy every tenant table carries. Scoped to savvy_app so the
// superuser migration/seed connection is unaffected. Returns a fresh policy
// per table (each references that table's own tenant_id column).
export const tenantIsolation = () =>
  pgPolicy("tenant_isolation", {
    as: "permissive",
    for: "all",
    to: "savvy_app",
    using: sql`tenant_id = current_setting('app.tenant_id')::uuid`,
    withCheck: sql`tenant_id = current_setting('app.tenant_id')::uuid`,
  });
