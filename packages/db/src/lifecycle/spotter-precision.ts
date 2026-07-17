import { and, eq, isNotNull } from "drizzle-orm";
import { computeSpotterPrecision, type RoofMaterial, type SpotterPrecision } from "@savvy/core";
import { withTenant } from "../tenant";
import { property } from "../schema/crm";
import { spotterPin } from "../schema/strike-list";

// Strike List slice 2 (#266) — the spotter accuracy loop. Score each tagger
// against inspection ground truth: for every pin whose matched property was
// later confirmed by a human inspection, did the spotter's material tag agree?
// Pins matched to un-inspected properties have no ground truth and are excluded
// (no evidence to score). Persistently low scorers surface a coaching flag.

export async function spotterPrecisionReport(tenantId: string): Promise<SpotterPrecision[]> {
  const rows = await withTenant(tenantId, (tx) =>
    tx.select({
      spotterName: spotterPin.spotterName,
      tagged: spotterPin.materialTag,
      truth: property.roofMaterial,
    })
      .from(spotterPin)
      .innerJoin(property, eq(property.id, spotterPin.matchedPropertyId))
      .where(and(
        eq(spotterPin.tenantId, tenantId),
        isNotNull(spotterPin.spotterName),
        isNotNull(spotterPin.materialTag),
        eq(property.roofMaterialSource, "inspection"), // ground truth only
      )));

  const bySpotter = new Map<string, { tagged: RoofMaterial; truth: RoofMaterial }[]>();
  for (const r of rows) {
    if (!r.spotterName || !r.tagged || !r.truth) continue;
    const list = bySpotter.get(r.spotterName) ?? [];
    list.push({ tagged: r.tagged as RoofMaterial, truth: r.truth as RoofMaterial });
    bySpotter.set(r.spotterName, list);
  }

  return [...bySpotter.entries()].map(([name, samples]) => computeSpotterPrecision(name, samples));
}
