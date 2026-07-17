import { eq } from "drizzle-orm";
import { canUpgradeRoofMaterial, type RoofMaterial, type RoofMaterialSource } from "@savvy/core";
import { withTenant } from "../tenant";
import { property } from "../schema/crm";

// Strike List slice 1 — the ONE place property.roof_material is written. Every
// source (assessor import, spotter sync, inference sweep, cv pilot, inspection)
// funnels through here so the precedence ladder is enforced in a single spot
// instead of scattered across each writer. Mirrors setCustomerEmail's provenance
// guard, generalized from binary to the ranked ladder.

/**
 * Write a property's roof material, honoring source precedence
 * (inspection > spotter > assessor > cv_pilot > inference). A write is skipped
 * — returning false — when the stored value came from a strictly higher source.
 * A same-or-higher source (incl. a same-source refresh) writes and returns true.
 * roofType (legacy free-text) is deliberately left untouched; callers derive the
 * coarse type from roofMaterialToRoofType at read time.
 */
export async function setPropertyRoofMaterial(
  tenantId: string,
  input: { propertyId: string; material: RoofMaterial; source: RoofMaterialSource; confidence?: number | null },
): Promise<boolean> {
  return withTenant(tenantId, async (tx) => {
    const [cur] = await tx.select({ source: property.roofMaterialSource })
      .from(property).where(eq(property.id, input.propertyId));
    if (!cur) return false;
    if (!canUpgradeRoofMaterial(cur.source as RoofMaterialSource | null, input.source)) return false;

    await tx.update(property).set({
      roofMaterial: input.material,
      roofMaterialSource: input.source,
      roofMaterialConfidence: input.confidence ?? null,
    }).where(eq(property.id, input.propertyId));
    return true;
  });
}
