import { pgTable, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";
import { partner } from "./partner";
import { customer, property } from "./crm";
import { appointment } from "./comms";
import { inspection } from "./inspection";
import { job } from "./jobs";
import { invoice } from "./finance";

// Partner Ledger slice 4 — the paid roof-cert lane (Phase 0 #241). A cert
// request deliberately creates NO lead: certs are a paid product, not funnel
// entries, so they can never inflate a partner's sent/won numbers. The
// billing job (lead_id null) exists only so the $195 rides the existing
// invoice + dunning rails. cert.sla evidence: delivered-or-declined ≤48h.
export const certRequest = pgTable("cert_request", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  partnerId: uuid("partner_id").notNull().references(() => partner.id),
  customerId: uuid("customer_id").notNull().references(() => customer.id),
  propertyId: uuid("property_id").notNull().references(() => property.id),
  status: text("status").notNull().default("requested"), // requested|booked|inspected|delivered|declined
  priceCents: integer("price_cents").notNull(), // locked from config at request time
  customerEmail: text("customer_email"),
  appointmentId: uuid("appointment_id").references(() => appointment.id),
  inspectionId: uuid("inspection_id").references(() => inspection.id),
  jobId: uuid("job_id").references(() => job.id),
  invoiceId: uuid("invoice_id").references(() => invoice.id),
  certCode: text("cert_code"), // booking_link short code for the public cert page
  requestedAt: timestamp("requested_at", { withTimezone: true }).defaultNow().notNull(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  declinedAt: timestamp("declined_at", { withTimezone: true }),
  declineReason: text("decline_reason"),
  createdAt: createdAt(),
}, (t) => [
  index("cert_request_tenant_status_idx").on(t.tenantId, t.status),
  tenantIsolation(),
]);
