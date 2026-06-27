import { withTenant } from "../tenant";
import { materialOrder } from "../schema/procurement";
import { estimate } from "../schema/finance";
import { appointment } from "../schema/comms";
import { and, eq, asc, sql } from "drizzle-orm";
import {
  materialLinesFromEstimate,
  materialOrderSubtotalCents,
  neededByFromInstall,
  type EstimateLineItem,
  type MaterialOrderStatus,
} from "@savvy/core";

export type MaterialOrderRow = typeof materialOrder.$inferSelect;

/** Internal: earliest scheduled crew (install) appointment startsAt for a job, within a tx. */
async function earliestCrewInstallAt(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  jobId: string,
): Promise<Date | null> {
  const [appt] = await tx
    .select({ startsAt: appointment.startsAt })
    .from(appointment)
    .where(and(eq(appointment.jobId, jobId), eq(appointment.type, "crew"), eq(appointment.status, "scheduled")))
    .orderBy(asc(appointment.startsAt))
    .limit(1);
  return appt?.startsAt ?? null;
}

/** Earliest scheduled crew install date for a job (the install date). */
export async function getJobInstallDate(tenantId: string, jobId: string): Promise<Date | null> {
  return withTenant(tenantId, (tx) => earliestCrewInstallAt(tx, jobId));
}

/**
 * Generate a material order from an accepted estimate's material lines.
 * Idempotent per estimate: if one already exists it is returned unchanged.
 * Returns null when the estimate does not exist.
 */
export async function createMaterialOrderFromEstimate(input: {
  tenantId: string; estimateId: string;
}): Promise<MaterialOrderRow | null> {
  return withTenant(input.tenantId, async (tx) => {
    const [est] = await tx.select().from(estimate).where(eq(estimate.id, input.estimateId));
    if (!est) return null;

    const [existing] = await tx.select().from(materialOrder).where(eq(materialOrder.estimateId, input.estimateId));
    if (existing) return existing;

    const lines = materialLinesFromEstimate((est.lineItems ?? []) as EstimateLineItem[]);
    const subtotalCents = materialOrderSubtotalCents(lines);
    const installAt = await earliestCrewInstallAt(tx, est.jobId);
    const neededByAt = neededByFromInstall(installAt);

    const [row] = await tx.insert(materialOrder).values({
      tenantId: input.tenantId,
      jobId: est.jobId,
      estimateId: input.estimateId,
      status: "draft",
      lineItems: lines,
      subtotalCents,
      neededByAt,
    }).returning();
    return row!;
  });
}

/** Advance a material order's status; stamps orderedAt/deliveredAt on the matching transition. */
export async function setMaterialOrderStatus(input: {
  tenantId: string; materialOrderId: string; status: MaterialOrderStatus;
}): Promise<MaterialOrderRow> {
  return withTenant(input.tenantId, async (tx) => {
    const patch: Record<string, unknown> = { status: input.status };
    if (input.status === "ordered") patch.orderedAt = sql`now()`;
    if (input.status === "delivered") patch.deliveredAt = sql`now()`;
    const [row] = await tx.update(materialOrder).set(patch).where(eq(materialOrder.id, input.materialOrderId)).returning();
    return row!;
  });
}
