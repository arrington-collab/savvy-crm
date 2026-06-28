import { pgTable, uuid, integer, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { idCol, createdAt, tenantIsolation } from "./_rls";
import { tenant } from "./tenancy";
import { job } from "./jobs";
import { estimate } from "./finance";
import { materialOrderStatusEnum } from "./enums";
import type { MaterialOrderLine } from "@savvy/core";

// A bill of materials generated from an accepted estimate's material lines.
// `subtotal_cents` is the list-price BOM (price-book unit price = what the
// homeowner is charged). `cost_subtotal_cents` is the supplier cost (D2c),
// which IS summed into job.cost_cents on {ordered,delivered} via
// recomputeJobMaterialCost. One order per estimate (estimate_id unique).
export const materialOrder = pgTable("material_order", {
  id: idCol(),
  tenantId: uuid("tenant_id").notNull().references(() => tenant.id),
  jobId: uuid("job_id").notNull().references(() => job.id),
  estimateId: uuid("estimate_id").notNull().references(() => estimate.id),
  status: materialOrderStatusEnum("status").notNull().default("draft"),
  lineItems: jsonb("line_items").$type<MaterialOrderLine[]>().default([]).notNull(),
  subtotalCents: integer("subtotal_cents").notNull().default(0),
  costSubtotalCents: integer("cost_subtotal_cents").notNull().default(0),
  neededByAt: timestamp("needed_by_at", { withTimezone: true }),
  orderedAt: timestamp("ordered_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  index("material_order_tenant_job_idx").on(t.tenantId, t.jobId),
  index("material_order_tenant_status_idx").on(t.tenantId, t.status),
  uniqueIndex("material_order_estimate_uniq").on(t.estimateId),
  tenantIsolation(),
]);
