import { pgTable, uuid, text, index, uniqueIndex, timestamp } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";
import { customer } from "./crm";
import { job } from "./jobs";
import { partner } from "./partner";

// Customer for Life slice 1: the relationship calendar. EVERY post-completion
// program (roofiversary, holiday cards, storm checks, credit check-ins, move
// plays, future maintenance) schedules THROUGH this table — the governor's
// rolling-year cap and priority ladder read it, and nothing sends outside it.
export const relationshipTouch = pgTable("relationship_touch", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  // Partner Ledger slice 5: partner-scoped touches (quarterly reports) share
  // this ledger — exactly ONE of customer_id/partner_id is set (DB CHECK,
  // mig 0101). Customer gates (opt-outs, caps, disputes) apply only to
  // customer touches; partner touches keep sourceRef idempotency, suppression
  // rows and the sender-requires-touchId contract.
  customerId: uuid("customer_id").references(() => customer.id),
  partnerId: uuid("partner_id").references(() => partner.id),
  // holiday_card|roofiversary|storm_check|credit_checkin|maintenance_offer|referral|move_play|partner_quarterly|custom
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

// Customer for Life slice 2: the standing cadence's enrollment ledger. Every
// completed job (demo tenants excluded) enrolls its customer exactly once — or
// carries a suppressed_reason saying why not. The relationship.enrollment and
// relationship.cadence evidence queries read this table.
export const relationshipEnrollment = pgTable("relationship_enrollment", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  customerId: uuid("customer_id").notNull().references(() => customer.id),
  jobId: uuid("job_id").notNull().references(() => job.id),
  // Anchor for the cadence's date math = when the job reached stage complete.
  completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
  enrolledAt: timestamp("enrolled_at", { withTimezone: true }).defaultNow().notNull(),
  suppressedReason: text("suppressed_reason"),
  createdAt: createdAt(),
}, (t) => [
  // Slice 3: (tenant, job, customer) — a warranty transfer enrolls the NEW
  // owner against the same job while the original enrollment is preserved.
  uniqueIndex("relationship_enrollment_job_idx").on(t.tenantId, t.jobId, t.customerId),
  index("relationship_enrollment_tenant_customer_idx").on(t.tenantId, t.customerId),
  tenantIsolation(),
]);
