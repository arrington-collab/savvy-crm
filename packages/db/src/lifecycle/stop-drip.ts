import { and, eq } from "drizzle-orm";
import { dripEnrollment } from "../schema/index";
import type { DripStopReason } from "@savvy/core";

type Tx = Parameters<Parameters<typeof import("../client").db.transaction>[0]>[0];

/**
 * Marks every ACTIVE drip enrollment for a customer as stopped with the given
 * reason. Tenant-scoped (call inside withTenant). Returns the affected ids so
 * the caller can decide whether to emit drip/stop. Pure DB — emits no events.
 */
export async function stopDripEnrollments(
  tx: Tx,
  opts: { tenantId: string; customerId: string; reason: DripStopReason },
): Promise<string[]> {
  const rows = await tx
    .update(dripEnrollment)
    .set({ status: "stopped", stoppedReason: opts.reason })
    .where(and(
      eq(dripEnrollment.customerId, opts.customerId),
      eq(dripEnrollment.status, "active"),
    ))
    .returning({ id: dripEnrollment.id });
  return rows.map((r) => r.id);
}
