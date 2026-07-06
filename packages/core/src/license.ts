// Pure license-matrix resolver for Cell 17a. No DB access — takes an already-fetched
// license array so it is trivially unit-testable and reusable from both the scheduling
// block (@savvy/db) and the renewal evidence check (@savvy/core).

export type LicenseLike = {
  state: string;
  city: string | null;
  status: string;
  expiresAt: Date | null;
};

export type Jurisdiction = { state: string | null | undefined; city?: string | null };

const norm = (s: string | null | undefined): string => (s ?? "").trim().toUpperCase();

export function isLicenseActive(license: LicenseLike, now: Date): boolean {
  if (license.status !== "active") return false;
  return license.expiresAt == null || license.expiresAt > now;
}

export function resolveActiveLicense(
  licenses: LicenseLike[],
  jurisdiction: Jurisdiction,
  now: Date,
): LicenseLike | null {
  const state = norm(jurisdiction.state);
  if (state === "") return null; // caller decides escape-valve behavior for null state
  const city = norm(jurisdiction.city);
  const active = licenses.filter((l) => isLicenseActive(l, now) && norm(l.state) === state);
  // Prefer a city-specific match; fall back to a state-level (city == null) license.
  const citySpecific = active.find((l) => l.city != null && norm(l.city) === city);
  if (citySpecific) return citySpecific;
  return active.find((l) => l.city == null) ?? null;
}

export type RenewalStatus = "ok" | "expiring_soon" | "expired";

export function licenseRenewalStatus(
  license: Pick<LicenseLike, "expiresAt">,
  now: Date,
  windowDays = 60,
): RenewalStatus {
  if (license.expiresAt == null) return "ok";
  if (license.expiresAt <= now) return "expired";
  const days = (license.expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
  return days <= windowDays ? "expiring_soon" : "ok";
}
