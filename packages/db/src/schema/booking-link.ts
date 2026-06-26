import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";

export const bookingLink = pgTable("booking_link", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  code: text("code").notNull().unique(),
  token: text("token").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("booking_link_code_idx").on(t.code),
  tenantIsolation(),
]);
