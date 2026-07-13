export type RoofSizeBasis = "measured" | "assessor" | "footprint";

// Roof-type footprint→roof multipliers (pitch adds area over the flat footprint).
// A conservative default for unknown types keeps the ballpark honest.
const PITCH_FACTOR: Record<string, number> = {
  asphalt_shingle: 1.3,
  tile: 1.3,
  metal: 1.25,
  flat_foam: 1.05,
};
const DEFAULT_PITCH_FACTOR = 1.3;

/**
 * Best-available roof size in squares (1 square = 100 sqft), with the basis
 * that determines ballpark confidence. Precedence: a real measurement, else
 * assessor roof sqft, else building footprint × a roof-type pitch factor.
 * Pure. Returns null when nothing usable is present.
 */
export function resolveRoofSize(input: {
  measurementSquares: number | null;
  assessorRoofSqft: number | null;
  footprintSqft: number | null;
  roofType: string | null;
}): { squares: number; basis: RoofSizeBasis } | null {
  if (input.measurementSquares && input.measurementSquares > 0) {
    return { squares: input.measurementSquares, basis: "measured" };
  }
  if (input.assessorRoofSqft && input.assessorRoofSqft > 0) {
    return { squares: input.assessorRoofSqft / 100, basis: "assessor" };
  }
  if (input.footprintSqft && input.footprintSqft > 0) {
    const factor = (input.roofType && PITCH_FACTOR[input.roofType]) || DEFAULT_PITCH_FACTOR;
    return { squares: (input.footprintSqft * factor) / 100, basis: "footprint" };
  }
  return null;
}
