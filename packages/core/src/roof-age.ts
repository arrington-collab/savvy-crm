/**
 * Roof Record: effective age is ALWAYS a range with its source cited, never a
 * point estimate ("roof ~8–11 years — replaced 2016 per owner"). When the only
 * signal is an old build year, the honest answer is unknown (null) — the
 * Record renders "we'll confirm on site" rather than an invented number.
 */

export type RoofAgeRange = { minYears: number; maxYears: number; source: string };

// Beyond this build age with no replacement record, the roof may have been
// replaced 0–2 times — any range would be an invention.
const ORIGINAL_ROOF_MAX_YEARS = 15;

export function roofAgeRange(
  input: {
    lastRoofReplacementAt: string | Date | null;
    lastRoofReplacementSource: string | null;
    yearBuilt: number | null;
  },
  now: Date,
): RoofAgeRange | null {
  if (input.lastRoofReplacementAt) {
    const replaced = new Date(input.lastRoofReplacementAt);
    const age = Math.floor((now.getTime() - replaced.getTime()) / (365.25 * 86_400_000));
    const source = `replaced ${replaced.getUTCFullYear()}${input.lastRoofReplacementSource ? ` per ${input.lastRoofReplacementSource}` : ""}`;
    // ±window acknowledges recall/permit imprecision — never a point.
    return { minYears: Math.max(0, age - 2), maxYears: age + 1, source };
  }

  if (input.yearBuilt) {
    const age = now.getUTCFullYear() - input.yearBuilt;
    if (age <= ORIGINAL_ROOF_MAX_YEARS) {
      // Young home: the roof is almost certainly the original build.
      return { minYears: Math.max(0, age - 1), maxYears: age + 1, source: `original roof — built ${input.yearBuilt}` };
    }
  }
  return null;
}
