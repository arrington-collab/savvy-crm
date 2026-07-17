// Strike List Machine slice 1 — the structured roof-material vocabulary.
//
// The legacy `ROOF_TYPE_VALUES` (asphalt_shingle · tile · metal · flat_foam ·
// other) is coarse — good enough for an estimate, useless for pre-storm
// targeting where a *wood shake* vs *clay tile* vs *asbestos* roof is the whole
// signal ("golden roofs"). This finer vocabulary is the source of truth;
// `roofMaterialToRoofType` downcasts onto the legacy enum so the two reconcile
// instead of duplicating meaning.

import { ROOF_TYPE_VALUES } from "./schemas";

export const ROOF_MATERIAL_VALUES = [
  "asphalt_shingle", "wood_shake", "clay_tile", "concrete_tile",
  "metal", "flat_builtup", "asbestos_suspect", "other",
] as const;
export type RoofMaterial = (typeof ROOF_MATERIAL_VALUES)[number];

// Precedence-ranked, most authoritative first. inspection is a human on the
// roof; inference is a statistical guess from neighbors.
export const ROOF_MATERIAL_SOURCES = ["inspection", "spotter", "assessor", "cv_pilot", "inference"] as const;
export type RoofMaterialSource = (typeof ROOF_MATERIAL_SOURCES)[number];

// The high-value targeting materials: old shake/clay burn or shatter in hail,
// and asbestos-suspect roofs carry premium abatement scope. These are what the
// Strike List hunts for pre-storm.
export const GOLDEN_ROOF_MATERIALS: ReadonlySet<RoofMaterial> = new Set<RoofMaterial>([
  "wood_shake", "clay_tile", "asbestos_suspect",
]);

export function isGoldenRoof(material: RoofMaterial | string | null | undefined): boolean {
  return material != null && GOLDEN_ROOF_MATERIALS.has(material as RoofMaterial);
}

type RoofType = (typeof ROOF_TYPE_VALUES)[number];

/** Downcast a fine material onto the coarse legacy roof type. One source of
 *  truth — the legacy enum is derived, never separately maintained. */
export function roofMaterialToRoofType(material: RoofMaterial): RoofType {
  switch (material) {
    case "asphalt_shingle": return "asphalt_shingle";
    case "clay_tile":
    case "concrete_tile": return "tile";
    case "metal": return "metal";
    case "flat_builtup": return "flat_foam";
    case "wood_shake":
    case "asbestos_suspect":
    case "other": return "other";
  }
}

const SOURCE_RANK: Record<RoofMaterialSource, number> = ROOF_MATERIAL_SOURCES.reduce(
  (acc, s, i) => ({ ...acc, [s]: ROOF_MATERIAL_SOURCES.length - i }), // inspection highest
  {} as Record<RoofMaterialSource, number>,
);

/**
 * May an incoming write from `incoming` overwrite a value currently sourced
 * from `existing`? A value upgrades when the incoming source is at least as
 * authoritative (same source re-imports refresh in place); an empty value is
 * always fillable. inspection, the top rank, is never overwritten by anything
 * below it.
 */
export function canUpgradeRoofMaterial(
  existing: RoofMaterialSource | null | undefined,
  incoming: RoofMaterialSource,
): boolean {
  if (!existing) return true;
  return SOURCE_RANK[incoming] >= SOURCE_RANK[existing];
}
