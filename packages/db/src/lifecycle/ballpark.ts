import { and, eq, sql } from "drizzle-orm";
import { withTenant } from "../tenant";
import { auditLog, estimate } from "../schema/index";

/**
 * Log a spoken/sent ballpark on the lead with its inputs snapshot. Uses the
 * existing audit_log (action='ballpark.quoted') — no new table. The snapshot
 * is what the monthly calibration report and the ballpark.calibration invariant
 * read back.
 */
export async function logBallparkQuote(
  tenantId: string,
  input: { leadId: string; lowCents: number; highCents: number; confidence: string; basis: string; inputs: Record<string, unknown> },
): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx.insert(auditLog).values({
      tenantId,
      entityType: "lead",
      entityId: input.leadId,
      action: "ballpark.quoted",
      diff: { lowCents: input.lowCents, highCents: input.highCents, confidence: input.confidence, basis: input.basis, inputs: input.inputs },
    }),
  );
}

/**
 * Quoted range vs the lead's eventual accepted estimate value — the pairs the
 * calibration report scores. One pair per (quote, accepted estimate) match.
 */
export async function loadBallparkPairs(
  tenantId: string,
): Promise<{ lowCents: number; highCents: number; estimateCents: number }[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({
        lowCents: sql<number>`(${auditLog.diff} ->> 'lowCents')::int`,
        highCents: sql<number>`(${auditLog.diff} ->> 'highCents')::int`,
        estimateCents: sql<number>`${estimate.total}`,
      })
      .from(auditLog)
      .innerJoin(
        estimate,
        and(
          sql`${estimate.leadId} = ${auditLog.entityId}::uuid`,
          eq(estimate.tenantId, tenantId),
          eq(estimate.status, "accepted"),
          sql`${estimate.total} is not null`,
        ),
      )
      .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.action, "ballpark.quoted"), eq(auditLog.entityType, "lead")));
    return rows;
  });
}
