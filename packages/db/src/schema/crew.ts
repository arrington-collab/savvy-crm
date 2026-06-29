import { pgTable, uuid, text, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant, user } from "./tenancy";

// A crew is a named install team (a group of role='crew' users). Crew-type
// install appointments are assigned to a crew via appointment.crewId.
export const crew = pgTable("crew", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  name: text("name").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
}, (t) => [index("crew_tenant_idx").on(t.tenantId), tenantIsolation()]);

// Membership: which users belong to which crew (many-to-many).
export const crewMember = pgTable("crew_member", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  crewId: uuid("crew_id").notNull().references(() => crew.id),
  userId: uuid("user_id").notNull().references(() => user.id),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("crew_member_crew_user_uniq").on(t.crewId, t.userId),
  index("crew_member_tenant_idx").on(t.tenantId),
  tenantIsolation(),
]);
