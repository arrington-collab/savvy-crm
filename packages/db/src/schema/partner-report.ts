import { pgTable, uuid, text, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";
import { partner } from "./partner";
import { relationshipTouch } from "./relationship";

// Partner Ledger slice 5: the quarterly partner summary — a frozen snapshot
// (the payload is what was REPORTED, not a live query), a permanent tokenized
// page, and the governor touch that delivered it. A/B partners only: C
// partners get decision cards, never report cards (zero shame mechanics).
export const partnerReport = pgTable("partner_report", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  partnerId: uuid("partner_id").notNull().references(() => partner.id),
  quarterKey: text("quarter_key").notNull(), // e.g. 2026-Q2 (the quarter summarized)
  payload: jsonb("payload").notNull(), // { sent, inspected, estimated, won, certsDelivered, netCents, ... }
  reportCode: text("report_code"), // booking_link short code for the public page
  touchId: uuid("touch_id").references(() => relationshipTouch.id),
  createdAt: createdAt(),
}, (t) => [
  index("partner_report_tenant_quarter_idx").on(t.tenantId, t.quarterKey),
  uniqueIndex("partner_report_partner_quarter_uq").on(t.tenantId, t.partnerId, t.quarterKey),
  tenantIsolation(),
]);
