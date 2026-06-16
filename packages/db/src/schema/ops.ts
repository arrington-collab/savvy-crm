import { pgTable, uuid, text, integer, jsonb, index } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant, user } from "./tenancy";
import { customer, property } from "./crm";
import { job } from "./jobs";

export const document = pgTable("document", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  jobId: uuid("job_id").references(() => job.id),
  customerId: uuid("customer_id").references(() => customer.id),
  kind: text("kind").notNull(), // photo|measurement|contract|lien_waiver|cert|evidence|other
  label: text("label"),
  r2Key: text("r2_key").notNull(),
  filename: text("filename"),
  mime: text("mime"),
  sizeBytes: integer("size_bytes"),
  source: text("source").default("upload"), // companycam|savvy|upload
  sharedWith: jsonb("shared_with").$type<unknown[]>().default([]).notNull(),
  createdAt: createdAt(),
}, (t) => [index("document_tenant_job_idx").on(t.tenantId, t.jobId), tenantIsolation()]);

export const measurement = pgTable("measurement", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  propertyId: uuid("property_id").notNull().references(() => property.id),
  provider: text("provider").default("roofr"),
  reportUrl: text("report_url"),
  areas: jsonb("areas").$type<Record<string, unknown>>().default({}).notNull(),
  pitch: text("pitch"),
  orderedByUserId: uuid("ordered_by_user_id").references(() => user.id),
  costCents: integer("cost_cents"),
  createdAt: createdAt(),
}, (t) => [index("measurement_tenant_idx").on(t.tenantId), tenantIsolation()]);
