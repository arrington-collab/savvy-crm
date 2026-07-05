import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { idCol, createdAt, updatedAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";

// Per-tenant, per-jurisdiction license matrix (Cell 17a). city NULL = state-level
// license (e.g. AZ ROC covers all AZ cities); city set = municipal registration
// (Denver, Aurora). The scheduling block invariant (bookAppointment) refuses to
// schedule in a jurisdiction with no active license row here.
export const license = pgTable("license", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  state: text("state").notNull(),
  city: text("city"),
  authority: text("authority").notNull(),
  licenseNumber: text("license_number").notNull(),
  status: text("status").notNull(), // active | pending | expired | suspended
  issuedAt: timestamp("issued_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index("license_tenant_state_city_idx").on(t.tenantId, t.state, t.city),
  tenantIsolation(),
]);
