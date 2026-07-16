import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant, user } from "./tenancy";
import { mailCampaign } from "./mail";
import { job } from "./jobs";
import { document } from "./ops";

// Phase 26 slice 2: Facebook boost CARDS — manual-trigger by owner decision
// (no Meta API automation; ads spend is payout-gated out). Auto-generated
// street-level creative; the job photo rides along ONLY when the customer's
// marketing-consent flag is set (boost.consent invariant). The card records
// boosted/skipped so execution is provable, never assumed.
export const boostCard = pgTable("boost_card", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  campaignId: uuid("campaign_id").notNull().references(() => mailCampaign.id),
  jobId: uuid("job_id").notNull().references(() => job.id),
  kind: text("kind").notNull(), // day_before|day_of
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
  copy: text("copy").notNull(),
  photoDocumentId: uuid("photo_document_id").references(() => document.id),
  status: text("status").notNull().default("pending"), // pending|boosted|skipped
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedByUserId: uuid("resolved_by_user_id").references(() => user.id),
  createdAt: createdAt(),
}, (t) => [
  index("boost_card_tenant_status_idx").on(t.tenantId, t.status),
  uniqueIndex("boost_card_campaign_kind_uq").on(t.tenantId, t.campaignId, t.kind),
  tenantIsolation(),
]);
