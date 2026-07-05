import { pgTable, uuid, text, boolean, index } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";

// A canvassing field rep — a lightweight per-tenant identity (NOT a Clerk user)
// that logs into the door-knocking app with an individual PIN (scrypt hash, via
// @savvy/core hashPin/verifyPin). Deactivate with active=false; the rep's knocks
// are retained (Slice 4). Names are used to self-identify at the login screen.
export const canvassRep = pgTable("canvass_rep", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  name: text("name").notNull(),
  pinHash: text("pin_hash").notNull(),
  photoUrl: text("photo_url"),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
}, (t) => [index("canvass_rep_tenant_idx").on(t.tenantId), tenantIsolation()]);
