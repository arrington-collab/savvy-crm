import { pgTable, uuid, text, index, timestamp } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";
import { customer } from "./crm";

// Customer for Life slice 1: the relationship calendar. EVERY post-completion
// program (roofiversary, holiday cards, storm checks, credit check-ins, move
// plays, future maintenance) schedules THROUGH this table — the governor's
// rolling-year cap and priority ladder read it, and nothing sends outside it.
export const relationshipTouch = pgTable("relationship_touch", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  customerId: uuid("customer_id").notNull().references(() => customer.id),
  // holiday_card|roofiversary|storm_check|credit_checkin|maintenance_offer|referral|move_play|custom
  program: text("program").notNull(),
  channel: text("channel").notNull(), // text|postcard|letter|email
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  // displaced|cap_exceeded|opt_out|demo_mute|print_pending|claim_dispute|…
  suppressedReason: text("suppressed_reason"),
  templateVersion: text("template_version"),
  // Program-specific reference (creditId, batchId, …) for idempotency joins.
  sourceRef: text("source_ref"),
  createdAt: createdAt(),
}, (t) => [
  index("relationship_touch_tenant_customer_idx").on(t.tenantId, t.customerId, t.scheduledFor),
  index("relationship_touch_tenant_program_idx").on(t.tenantId, t.program),
  tenantIsolation(),
]);
