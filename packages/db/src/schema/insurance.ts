import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex, jsonb, doublePrecision } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";
import { job } from "./jobs";
import { lead, property } from "./crm";
import { claimStatusEnum } from "./enums";

// Thin claim tracking (slice G). The SuppIQ supplement intelligence (carrier/
// supplement tables, KB, letters) stays the deferred Phase-9 add-on; this is
// just the administrative claim record per insurance job.
export const claim = pgTable("claim", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  jobId: uuid("job_id").references(() => job.id),
  leadId: uuid("lead_id").references(() => lead.id),
  propertyId: uuid("property_id").references(() => property.id),
  claimNumber: text("claim_number"),
  carrierName: text("carrier_name"),
  adjusterName: text("adjuster_name"),
  adjusterPhone: text("adjuster_phone"),
  status: claimStatusEnum("status").notNull().default("filed"),
  acvCents: integer("acv_cents"),
  rcvCents: integer("rcv_cents"),
  deductibleCents: integer("deductible_cents"),
  filedAt: timestamp("filed_at", { withTimezone: true }),
  // Cell 16 mortgage endorsement chase. lender_name = the mortgage co-payee on the
  // claim check (co-payee detection). endorsement_status tracks the chase; the
  // 5-business-day no-idle invariant (claim.endorsement_no_idle) watches open ones.
  lenderName: text("lender_name"),
  endorsementStatus: text("endorsement_status").notNull().default("none"), // none|needed|requested|received|not_applicable
  endorsementLastActionAt: timestamp("endorsement_last_action_at", { withTimezone: true }),
  // Slice 6c: parsed carrier line items + parse confidence (lead-stage insurance-estimate parse).
  lineItems: jsonb("line_items").$type<unknown[]>(),
  parseConfidence: doublePrecision("parse_confidence"),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("claim_job_uniq").on(t.jobId).where(sql`${t.jobId} is not null`),
  uniqueIndex("claim_lead_open_uniq").on(t.leadId).where(sql`${t.leadId} is not null and ${t.jobId} is null`),
  index("claim_tenant_status_idx").on(t.tenantId, t.status),
  tenantIsolation(),
]);
