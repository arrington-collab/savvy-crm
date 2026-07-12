import { pgTable, uuid, text, boolean, integer, index, jsonb, timestamp } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant, user } from "./tenancy";

// One numbered item persisted with a digest snapshot. Mirrors @savvy/core's
// SageDigestItem plus the display number, so an inbound "reply N" resolves the
// exact exception the owner saw — the ExceptionQueue normalizes these ids away,
// so we snapshot them here at send time. `action` is one of @savvy/core's
// SageActionKind values (kept as a plain string to avoid a db→core type dep).
export type SageDigestItemRow = {
  n: number;
  kind: string;
  entityId: string;
  jobId: string | null;
  title: string;
  detail: string;
  action: string | null;
  confirmAmountCents: number | null;
};

// The numbered digest sent to one owner. Only the latest un-superseded row per
// (tenant, user) is active; sending a new digest supersedes the prior one so a
// stale "reply 1" cannot resolve an item the owner can no longer see.
export const sageDigest = pgTable(
  "sage_digest",
  {
    id: idCol(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    userId: uuid("user_id").notNull().references(() => user.id),
    items: jsonb("items").$type<SageDigestItemRow[]>().notNull().default([]),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("sage_digest_tenant_user_idx").on(t.tenantId, t.userId, t.createdAt), tenantIsolation()],
);

// Evidence log for every SMS/voice-initiated Sage action. verified=false rows
// are ALWAYS confirmation_state='rejected' (the gate blocked them, no action
// taken); the sage.remote_actions invariant fails if any verified=false row is
// non-rejected. Money actions above threshold pass through 'pending' → then
// 'confirmed' (YES) or 'rejected' (NO).
export const sageRemoteAction = pgTable(
  "sage_remote_action",
  {
    id: idCol(),
    tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
    userId: uuid("user_id").references(() => user.id),
    phone: text("phone").notNull(),
    digestId: uuid("digest_id"),
    n: integer("n"),
    kind: text("kind").notNull(),
    exceptionRef: text("exception_ref"),
    action: text("action"),
    confirmationState: text("confirmation_state").notNull(), // immediate | pending | confirmed | rejected
    verified: boolean("verified").notNull(),
    result: text("result"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("sage_remote_action_tenant_idx").on(t.tenantId, t.createdAt), tenantIsolation()],
);
