import { sql } from "drizzle-orm";
import { pgTable, uuid, text, uniqueIndex, index } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";

// Global opt-out / suppression — the single source of truth every comms agent
// reads before sending. Additive to per-customer consent (smsOptOut etc.):
// this suppresses by phone/email GLOBALLY across all agents + campaigns.
export const contactSuppression = pgTable("contact_suppression", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  locationId: uuid("location_id"),        // nullable until locations modeled
  contactId: uuid("contact_id"),          // best-effort link; the key is phone/email
  phoneE164: text("phone_e164"),
  email: text("email"),
  channel: text("channel").notNull(),     // 'sms' | 'email' | 'all'
  reason: text("reason").notNull(),       // 'stop' | 'manual' | 'bounce' | 'complaint'
  source: text("source").notNull(),       // which agent/flow recorded it
  createdAt: createdAt(),
}, (t) => [
  // Idempotent intake: one suppression per (tenant, key, channel). The key is
  // phone OR email; a partial unique index per key keeps both usable without
  // colliding on NULLs.
  uniqueIndex("contact_suppression_phone_uq").on(t.tenantId, t.phoneE164, t.channel).where(sql`phone_e164 is not null`),
  uniqueIndex("contact_suppression_email_uq").on(t.tenantId, t.email, t.channel).where(sql`email is not null`),
  index("contact_suppression_contact_idx").on(t.tenantId, t.contactId),
  tenantIsolation(),
]);
