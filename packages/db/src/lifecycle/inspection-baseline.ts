// Roof Record slice 4: the baseline. Every property's FIRST published initial
// Record becomes its permanent condition baseline — the artifact that protects
// the homeowner's claim when a storm hits. The storm sentinel (wave 2) and this
// slice's lightweight storm hook both consume getBaselinedProperties.

import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { withTenant } from "../tenant";
import { inspection } from "../schema/inspection";
import { property } from "../schema/crm";
import { pointInPolygon, type GeoPoint } from "@savvy/core";

export type BaselinedProperty = {
  propertyId: string;
  address: string;
  customerId: string | null;
  lat: number;
  lng: number;
  baselineInspectionId: string;
  baselineAt: Date;
};

/** Baselined properties with coordinates; optional polygon narrows to a storm
 *  swath. The wave-2 storm sentinel consumes this exact interface. */
export async function getBaselinedProperties(
  tenantId: string,
  polygon?: GeoPoint[],
): Promise<BaselinedProperty[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.select({
      propertyId: property.id,
      address: property.address,
      customerId: property.customerId,
      lat: property.lat,
      lng: property.lng,
      baselineInspectionId: property.baselineInspectionId,
      baselineAt: property.baselineAt,
    }).from(property)
      .where(and(isNotNull(property.baselineInspectionId), isNotNull(property.lat), isNotNull(property.lng)));

    const withCoords = rows.filter(
      (r): r is typeof r & { lat: number; lng: number; baselineInspectionId: string; baselineAt: Date } =>
        r.lat != null && r.lng != null && r.baselineInspectionId != null && r.baselineAt != null,
    );
    const inArea = polygon?.length
      ? withCoords.filter((r) => pointInPolygon({ lat: r.lat, lng: r.lng }, polygon))
      : withCoords;
    return inArea.map((r) => ({
      propertyId: r.propertyId,
      address: r.address,
      customerId: r.customerId,
      lat: r.lat,
      lng: r.lng,
      baselineInspectionId: r.baselineInspectionId,
      baselineAt: r.baselineAt,
    }));
  });
}

/** baseline.coverage evidence: published INITIAL Records whose property has no
 *  baseline set. Must be empty — each is a missed hook. */
export async function baselineCoverageGaps(
  tenantId: string,
): Promise<{ inspectionId: string; propertyId: string }[]> {
  return withTenant(tenantId, (tx) =>
    tx.select({ inspectionId: inspection.id, propertyId: inspection.propertyId })
      .from(inspection)
      .innerJoin(property, eq(inspection.propertyId, property.id))
      .where(and(
        eq(inspection.status, "published"),
        eq(inspection.kind, "initial"),
        isNull(property.baselineInspectionId),
      )),
  );
}

/** The publish hook body: first-publish wins, later publishes never overwrite.
 *  The guarded UPDATE makes replays and racing publishes idempotent. */
export async function setPropertyBaselineTx(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  input: { propertyId: string; inspectionId: string; publishedAt: Date },
): Promise<void> {
  await tx.update(property)
    .set({ baselineInspectionId: input.inspectionId, baselineAt: input.publishedAt })
    .where(and(eq(property.id, input.propertyId), sql`${property.baselineInspectionId} is null`));
}
