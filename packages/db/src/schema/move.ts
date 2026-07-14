import { pgTable, uuid, text, integer, index, jsonb, timestamp } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";
import { customer, property } from "./crm";

// Customer for Life slice 3: move detection. Signals accumulate on ONE open
// event per customer+property; the confidence threshold decides confirmed vs
// pending_verification (= the /today verification card). A confirmed move runs
// both plays: Play A woos the customer at the new address, Play B offers the
// old address's new owner the warranty transfer + Roof Record.
export const moveEvent = pgTable("move_event", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  customerId: uuid("customer_id").notNull().references(() => customer.id),
  propertyId: uuid("property_id").notNull().references(() => property.id),
  // [{ kind: "ncoa"|"returned_mail"|"manual", detail?, at }]
  signals: jsonb("signals").$type<{ kind: string; detail?: string; at: string }[]>().default([]).notNull(),
  confidence: integer("confidence").notNull().default(0),
  // detected|pending_verification|confirmed|dismissed
  status: text("status").notNull().default("detected"),
  newAddress: text("new_address"),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  index("move_event_tenant_status_idx").on(t.tenantId, t.status),
  index("move_event_tenant_customer_idx").on(t.tenantId, t.customerId),
  tenantIsolation(),
]);

// Play B's artifact: the transferable workmanship warranty. Always carries the
// property's Roof Record link (baseline inspection) when one exists — the
// relationship.move_play evidence checks that invariant. The letter itself
// holds as letter_status=print_pending until the PostGrid build mails it.
export const warrantyTransfer = pgTable("warranty_transfer", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  propertyId: uuid("property_id").notNull().references(() => property.id),
  fromCustomerId: uuid("from_customer_id").notNull().references(() => customer.id),
  toCustomerId: uuid("to_customer_id").references(() => customer.id),
  moveEventId: uuid("move_event_id").references(() => moveEvent.id),
  baselineInspectionId: uuid("baseline_inspection_id"),
  // offered|registered
  status: text("status").notNull().default("offered"),
  // print_pending until PostGrid; sent once mailed
  letterStatus: text("letter_status").notNull().default("print_pending"),
  registeredAt: timestamp("registered_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  index("warranty_transfer_tenant_property_idx").on(t.tenantId, t.propertyId),
  index("warranty_transfer_tenant_status_idx").on(t.tenantId, t.status),
  tenantIsolation(),
]);
