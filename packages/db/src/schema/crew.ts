import { pgTable, uuid, text, boolean, doublePrecision, index, uniqueIndex } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant, user } from "./tenancy";

// A crew is a named install team (a group of role='crew' users). Crew-type
// install appointments are assigned to a crew via appointment.crewId.
export const crew = pgTable("crew", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  name: text("name").notNull(),
  active: boolean("active").notNull().default(true),
  // Slice 3: crew-facing message language ('en'|'es', validated by @savvy/core
  // CrewLanguage). Self-service flip via replying "ESPAÑOL" to any crew message.
  language: text("language").notNull().default("en"),
  // Crew's home base (yard) — used as the drive-time origin for install slot
  // recommendations. Null falls back to the tenant office.
  baseLat: doublePrecision("base_lat"),
  baseLng: doublePrecision("base_lng"),
  // Shared crew login PIN (scrypt hash). A member enters it then taps their name,
  // so check-ins stay attributed to the individual. Null = no shared PIN.
  pinHash: text("pin_hash"),
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
