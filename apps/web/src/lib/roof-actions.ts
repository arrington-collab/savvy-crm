"use server";
import { confirmPropertyRoofType } from "@savvy/db";
import { revalidatePath } from "next/cache";
import { ROOF_MATERIAL_VALUES, type RoofMaterial } from "@savvy/core";
import { getTenantId } from "./tenant";

/** Resolve a `roof_type_needed` decision in place from the Today queue. Records
 *  the fine material (source "inspection", top of the ladder) AND the derived
 *  legacy roofType — the latter is what the exception keys on, so writing it is
 *  what makes the card drop off. */
export async function resolveRoofTypeAction(
  propertyId: string,
  material: RoofMaterial,
): Promise<{ ok: true } | { error: string }> {
  try {
    if (!ROOF_MATERIAL_VALUES.includes(material)) return { error: "unknown roof material" };
    const tenantId = await getTenantId();
    const updated = await confirmPropertyRoofType(tenantId, { propertyId, material });
    if (!updated) return { error: "could not update roof type" };
    revalidatePath("/today");
    return { ok: true };
  } catch {
    return { error: "could not update roof type" };
  }
}
