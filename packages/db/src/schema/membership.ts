import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { idCol, createdAt, updatedAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";
import { customer } from "./crm";

// Phase 20 (#305) — the annual tune-up membership. Stripe recurring is the
// billing rail; without a connected account the row parks as 'draft' (the
// cert-lane fail-soft pattern) — a fake 'active' is never possible, and the
// reconciliation invariant is memberships ↔ Stripe subscriptions.
export const membership = pgTable("membership", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  customerId: uuid("customer_id").notNull().references(() => customer.id),
  // draft (no payment rail) | pending (checkout open) | active | past_due | canceled
  status: text("status").notNull().default("pending"),
  annualPriceCents: integer("annual_price_cents").notNull(),
  // #306 conversion tracking: which offer source produced this membership.
  // manual | post_job | inspection_no_sale | winback | debris_funnel (Wave 2)
  source: text("source").notNull().default("manual"),
  checkoutSessionId: text("checkout_session_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  canceledAt: timestamp("canceled_at", { withTimezone: true }),
  cancellationReason: text("cancellation_reason"), // moved | financial | unsatisfied | other — required on cancel
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index("membership_tenant_idx").on(t.tenantId),
  index("membership_tenant_customer_idx").on(t.tenantId, t.customerId),
  // One live membership per customer (draft/pending/active) — renewals reuse it.
  uniqueIndex("membership_live_uq").on(t.tenantId, t.customerId).where(sql`status in ('draft','pending','active','past_due')`),
  tenantIsolation(),
]);
