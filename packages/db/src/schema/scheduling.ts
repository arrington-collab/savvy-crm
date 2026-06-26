import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant, user } from "./tenancy";

export const repAvailabilityBlock = pgTable(
  "rep_availability_block",
  {
    id: idCol(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    userId: uuid("user_id").notNull().references(() => user.id),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [index("rep_block_tenant_user_idx").on(t.tenantId, t.userId, t.startsAt), tenantIsolation()],
);
