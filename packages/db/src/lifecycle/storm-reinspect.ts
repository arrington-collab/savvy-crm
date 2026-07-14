// Roof Record slice 4: the lightweight storm hook. A verified storm event
// intersecting baselined addresses raises ONE card per event with the affected
// roofs and a proposed re-inspection outreach. The OWNER approves the batch;
// NOVA sends (service framing — "checking your roof against its baseline");
// bookings create kind=post_storm inspections linked to their baseline.

import { and, eq, isNull, inArray } from "drizzle-orm";
import { withTenant } from "../tenant";
import { inspection, stormReinspectBatch } from "../schema/index";
import { pointInPolygon } from "@savvy/core";
import { getBaselinedProperties } from "./inspection-baseline";

export type StormSwathInput = {
  kind: "hail" | "wind";
  rings: number[][][]; // [lat, lng] vertices per ring (StormProof shape)
  size: number | null;
  windMph: number | null;
  date: string;
};

/** One stable id per event: the same swath never cards twice. */
export function stormSwathSignature(s: StormSwathInput): string {
  return `${s.kind}|${s.date}|${s.size ?? ""}|${s.windMph ?? ""}`;
}

export type ProposeBatchResult =
  | { batchId: string; affected: number }
  | { skipped: "no_baselined_roofs" | "already_proposed" };

export async function proposeStormReinspectBatch(input: {
  tenantId: string;
  swath: StormSwathInput;
}): Promise<ProposeBatchResult> {
  const signature = stormSwathSignature(input.swath);
  const polygons = input.swath.rings.map((ring) => ring.map(([lat, lng]) => ({ lat: lat!, lng: lng! })));

  const baselined = await getBaselinedProperties(input.tenantId);
  const affected = baselined.filter((p) => polygons.some((poly) => pointInPolygon({ lat: p.lat, lng: p.lng }, poly)));
  if (affected.length === 0) return { skipped: "no_baselined_roofs" as const };

  return withTenant(input.tenantId, async (tx) => {
    const [existing] = await tx.select({ id: stormReinspectBatch.id }).from(stormReinspectBatch)
      .where(and(eq(stormReinspectBatch.tenantId, input.tenantId), eq(stormReinspectBatch.signature, signature)));
    if (existing) return { skipped: "already_proposed" as const };

    const inserted = await tx.insert(stormReinspectBatch).values({
      tenantId: input.tenantId,
      signature,
      kind: input.swath.kind,
      eventDate: input.swath.date,
      meta: { size: input.swath.size, windMph: input.swath.windMph },
      properties: affected.map((p) => ({
        propertyId: p.propertyId, customerId: p.customerId, address: p.address,
        baselineAt: p.baselineAt.toISOString(), baselineInspectionId: p.baselineInspectionId,
      })),
    }).onConflictDoNothing().returning({ id: stormReinspectBatch.id });
    if (!inserted[0]) return { skipped: "already_proposed" as const };
    return { batchId: inserted[0].id, affected: affected.length };
  });
}

export async function approveStormReinspectBatch(input: {
  tenantId: string;
  batchId: string;
  userId: string;
}): Promise<{ approvedAt: Date } | { error: "not_proposed" }> {
  return withTenant(input.tenantId, async (tx) => {
    const approvedAt = new Date();
    const [row] = await tx.update(stormReinspectBatch)
      .set({ status: "approved", approvedByUserId: input.userId, approvedAt })
      .where(and(eq(stormReinspectBatch.id, input.batchId), eq(stormReinspectBatch.status, "proposed")))
      .returning({ id: stormReinspectBatch.id });
    if (!row) return { error: "not_proposed" as const };
    return { approvedAt };
  });
}

export async function dismissStormReinspectBatch(input: {
  tenantId: string;
  batchId: string;
}): Promise<{ dismissed: true } | { error: "not_open" }> {
  return withTenant(input.tenantId, async (tx) => {
    const [row] = await tx.update(stormReinspectBatch)
      .set({ status: "dismissed" })
      .where(and(eq(stormReinspectBatch.id, input.batchId), inArray(stormReinspectBatch.status, ["proposed", "approved"])))
      .returning({ id: stormReinspectBatch.id });
    if (!row) return { error: "not_open" as const };
    return { dismissed: true as const };
  });
}

export async function markStormBatchSent(input: { tenantId: string; batchId: string }): Promise<void> {
  await withTenant(input.tenantId, (tx) => tx.update(stormReinspectBatch)
    .set({ status: "sent", sentAt: new Date() })
    .where(and(eq(stormReinspectBatch.id, input.batchId), eq(stormReinspectBatch.status, "approved"))));
}

export async function listOpenStormBatches(tenantId: string): Promise<(typeof stormReinspectBatch.$inferSelect)[]> {
  return withTenant(tenantId, (tx) => tx.select().from(stormReinspectBatch)
    .where(inArray(stormReinspectBatch.status, ["proposed", "approved"])));
}

/** inspection.linked_reinspection evidence: every post_storm inspection links
 *  a baseline. Must be empty. */
export async function unlinkedReinspections(tenantId: string): Promise<{ inspectionId: string }[]> {
  return withTenant(tenantId, (tx) => tx.select({ inspectionId: inspection.id }).from(inspection)
    .where(and(eq(inspection.kind, "post_storm"), isNull(inspection.baselineInspectionId))));
}
