import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant, user } from "./tenancy";
import { crew } from "./crew";

// Phase 26 slice 5 (#351, #352) — slow-week fill loop. The capacity look-ahead
// emits a crew-gap row when a hole opens inside the config window; the
// INVARIANT is that every gap ends 'planned' (>=1 fill play) or 'passed'
// (pass_reason logged) — never silently ignored.

export const crewGap = pgTable("crew_gap", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  crewId: uuid("crew_id").notNull().references(() => crew.id),
  // Civil dates (YYYY-MM-DD) in the tenant's timezone, inclusive.
  gapStart: text("gap_start").notNull(),
  gapEnd: text("gap_end").notNull(),
  freeMinutes: integer("free_minutes").notNull(),
  status: text("status").notNull().default("open"), // open | planned | passed
  passReason: text("pass_reason"),
  detectedAt: timestamp("detected_at", { withTimezone: true }).defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, (t) => [
  index("crew_gap_tenant_idx").on(t.tenantId),
  // The detector sweep is idempotent: one OPEN row per crew+start; a re-run
  // extends/re-plans the existing gap instead of stacking duplicates.
  uniqueIndex("crew_gap_open_uq").on(t.tenantId, t.crewId, t.gapStart).where(sql`resolved_at IS NULL`),
  tenantIsolation(),
]);

// A fill play is one concrete offer against a gap, routed through the touch
// governor. The approval card is a STATUS ('pending_approval'), not a separate
// table — same shape as the blitz over-cap card on mail_campaign.
export const fillPlay = pgTable("fill_play", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  gapId: uuid("gap_id").notNull().references(() => crewGap.id),
  kind: text("kind").notNull(), // estimate_discount | repair_offer | maintenance_pullforward
  // The estimate / repair credit / relationship touch this play targets.
  targetRef: text("target_ref").notNull(),
  discountBps: integer("discount_bps"),
  originalTotalCents: integer("original_total_cents"),
  discountedTotalCents: integer("discounted_total_cents"),
  status: text("status").notNull().default("proposed"), // proposed | pending_approval | sent | suppressed | converted | expired | skipped
  suppressedReason: text("suppressed_reason"),
  createdAt: createdAt(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedByUserId: uuid("resolved_by_user_id").references(() => user.id),
}, (t) => [
  index("fill_play_tenant_idx").on(t.tenantId),
  index("fill_play_gap_idx").on(t.gapId),
  // One play per gap+kind+target: the sweep can re-run without re-offering.
  uniqueIndex("fill_play_target_uq").on(t.tenantId, t.gapId, t.kind, t.targetRef),
  tenantIsolation(),
]);
