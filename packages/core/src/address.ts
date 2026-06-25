/**
 * Best-effort city extraction from a free-text US address. Heuristic, NOT a geocoder.
 * Looks for the comma-segment that ends in "<STATE> <ZIP>" and returns the text before
 * the state token. Returns null when no city can be confidently identified.
 *
 *   "123 Main St, Mesa AZ 85201"         -> "Mesa"
 *   "45 Oak Ave, Phoenix, AZ 85003"      -> "Phoenix"
 *   "9 Hill Rd, San Tan Valley AZ 85140" -> "San Tan Valley"
 *   "unknown" / "123 Main St, Apt 4"     -> null
 */
export function parseCityFromAddress(address: string): string | null {
  if (!address) return null;
  const segments = address.split(",").map((s) => s.trim()).filter(Boolean);
  if (segments.length < 2) return null;
  const stateZip = /\b[A-Za-z]{2}\s+\d{5}(?:-\d{4})?$/;
  for (let i = segments.length - 1; i >= 1; i--) {
    const seg = segments[i]!;
    if (stateZip.test(seg)) {
      const cityPart = seg.replace(stateZip, "").trim();
      if (cityPart) return cityPart.replace(/\s+/g, " ");
      const prev = segments[i - 1]?.trim();
      return prev ? prev.replace(/\s+/g, " ") : null;
    }
  }
  return null;
}

/**
 * Normalize a county value into a display label, appending "County" only when
 * it isn't already there. Google Places returns "Maricopa County" while the
 * StormProof assessor returns "Maricopa" — this avoids a doubled "County County".
 * Returns null for an empty/whitespace value.
 */
export function formatCountyLabel(county: string | null | undefined): string | null {
  const c = county?.trim();
  if (!c) return null;
  return /county$/i.test(c) ? c : `${c} County`;
}

// Canonical form for duplicate matching: lowercase, drop punctuation, collapse whitespace.
export function normalizeAddress(addr: string | null | undefined): string {
  if (!addr) return "";
  return addr
    .toLowerCase()
    .replace(/[.,#]/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
