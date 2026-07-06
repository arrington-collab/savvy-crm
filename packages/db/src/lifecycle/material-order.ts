import { withTenant } from "../tenant";
import { materialOrder } from "../schema/procurement";
import { estimate } from "../schema/finance";
import { appointment } from "../schema/comms";
import { priceBookItem } from "../schema/pricing";
import { job } from "../schema/jobs";
import { and, eq, asc, inArray, sql } from "drizzle-orm";
import {
  materialLinesFromEstimate,
  materialOrderSubtotalCents,
  attachMaterialCosts,
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

/** Recompute job.costCents as the sum of material-order cost in {ordered,delivered}. Idempotent. */
async function recomputeJobMaterialCost(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  jobId: string,
): Promise<void> {
  const [agg] = await tx
    .select({ total: sql<number>`coalesce(sum(${materialOrder.costSubtotalCents}), 0)::int` })
    .from(materialOrder)
    .where(and(eq(materialOrder.jobId, jobId), inArray(materialOrder.status, ["ordered", "delivered"])));
  await tx.update(job).set({ costCents: agg?.total ?? 0 }).where(eq(job.id, jobId));
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
    // Material orders require a job-attached estimate. A lead-stage draft (job_id
    // null) can't be ordered against until acceptance creates the job.
    if (!est.jobId) throw new Error("cannot order materials for a lead-stage estimate without an accepted job");
    const jobId = est.jobId;

    // Fix 2: explicit tenant scoping for defense-in-depth (not relying solely on RLS)
    const [existing] = await tx.select().from(materialOrder).where(and(eq(materialOrder.estimateId, input.estimateId), eq(materialOrder.tenantId, input.tenantId)));
    if (existing) return existing;

    const lines = materialLinesFromEstimate((est.lineItems ?? []) as EstimateLineItem[]);
    const subtotalCents = materialOrderSubtotalCents(lines);
    const pb = await tx.select({ key: priceBookItem.key, unitCostCents: priceBookItem.unitCostCents }).from(priceBookItem);
    const costByKey = Object.fromEntries(pb.map((p) => [p.key, p.unitCostCents]));
    const { lines: costedLines, costSubtotalCents } = attachMaterialCosts(lines, costByKey);
    const installAt = await earliestCrewInstallAt(tx, jobId);
    const neededByAt = neededByFromInstall(installAt);

    // Fix 1: onConflictDoNothing makes concurrent inserts idempotent — if this
    // transaction loses a race against another concurrent insert, no 23505 violation
    // is thrown; instead we re-select to return the winner's row.
    const [row] = await tx.insert(materialOrder).values({
      tenantId: input.tenantId,
      jobId,
      estimateId: input.estimateId,
      status: "draft",
      lineItems: costedLines,
      subtotalCents,
      costSubtotalCents,
      neededByAt,
    }).onConflictDoNothing({ target: materialOrder.estimateId }).returning();
    if (row) return row;
    // Lost the concurrent insert race — the unique index rejected ours; return the winner.
    const [winner] = await tx.select().from(materialOrder).where(and(eq(materialOrder.estimateId, input.estimateId), eq(materialOrder.tenantId, input.tenantId)));
    return winner!;
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
    // Fix 3: explicit not-found guard instead of non-null assertion
    if (!row) throw new Error(`material order ${input.materialOrderId} not found`);
    await recomputeJobMaterialCost(tx, row.jobId);
    return row;
  });
}
