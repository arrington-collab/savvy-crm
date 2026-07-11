import { canvassHaversineMeters } from "./canvass";

// ── Door dossier (Phase 1: internal data only) ────────────────────────────
// GET /api/canvass/dossier builds a small "opener" card for the knock modal
// from the tenant's own Savvy data: nearby jobs/customers, roofs on the same
// street, and the last knock at this door. The route does a cheap bounding-box
// prefilter in SQL; the precise haversine cut and assembly happen here so the
// logic is unit-testable without a database.

export const DOSSIER_NEARBY_METERS = 250;
export const DOSSIER_SAME_DOOR_METERS = 30;
export const DOSSIER_NEARBY_LIMIT = 8;
// ~0.004° ≈ 440 m of latitude — comfortably covers the 250 m nearby radius.
export const DOSSIER_JOB_BBOX_DEG = 0.004;
// Knocks only need the ~30 m same-door radius; ~0.0006° ≈ 66 m.
export const DOSSIER_KNOCK_BBOX_DEG = 0.0006;

export interface DossierBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

// Longitude degrees shrink with latitude, so widen the lng span by 1/cos(lat)
// (clamped so polar edge cases can't blow up the box).
export function dossierBoundingBox(lat: number, lng: number, deg: number): DossierBox {
  const lngDeg = deg / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  return { minLat: lat - deg, maxLat: lat + deg, minLng: lng - lngDeg, maxLng: lng + lngDeg };
}

// "1428 E Main St, Mesa, AZ" → "e main st". Lowercase, keep only the part
// before the first comma, strip a leading house number token. Returns null
// when nothing street-like remains (e.g. bare house number or empty string).
export function normalizeStreetName(address: string | null | undefined): string | null {
  if (!address) return null;
  const first = address.split(",")[0]!.toLowerCase().replace(/\s+/g, " ").trim();
  const street = first.replace(/^\d[\w/-]*\s+/, "").trim();
  if (!street || /^\d[\w/-]*$/.test(street)) return null;
  return street;
}

// Escape %, _ and \ so a street name can be embedded in an ILIKE pattern.
export function escapeIlike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export interface DossierJobRow {
  customerName: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  stage: string;
}

export interface DossierKnockRow {
  lat: number;
  lng: number;
  outcome: string;
  createdAt: Date;
  repName: string | null;
}

export interface DossierNearbyJob {
  customerName: string | null;
  address: string | null;
  distanceM: number;
  stage: string;
}

export interface CanvassDossier {
  roofsOnStreet: number;
  nearby: DossierNearbyJob[];
  priorKnock: { outcome: string; ts: string; repName: string | null } | null;
  isExistingCustomer: boolean;
}

export interface BuildDossierInput {
  lat: number;
  lng: number;
  /** Street address the canvasser is standing at (optional). */
  address?: string | null;
  /** Tenant jobs joined to property+customer, bbox-prefiltered around the point. */
  jobRows: DossierJobRow[];
  /** Addresses of tenant jobs whose property matched the street ILIKE prefilter. */
  streetAddresses: string[];
  /** Tenant knocks bbox-prefiltered to the same-door radius. */
  knockRows: DossierKnockRow[];
}

export function buildCanvassDossier(input: BuildDossierInput): CanvassDossier {
  const { lat, lng, address, jobRows, streetAddresses, knockRows } = input;

  const within = jobRows
    .filter((r) => typeof r.lat === "number" && typeof r.lng === "number")
    .map((r) => ({
      customerName: r.customerName,
      address: r.address,
      distanceM: canvassHaversineMeters(lat, lng, r.lat!, r.lng!),
      stage: r.stage,
    }))
    .filter((r) => r.distanceM <= DOSSIER_NEARBY_METERS)
    .sort((a, b) => a.distanceM - b.distanceM);

  // One line per household: a customer with several jobs at the same property
  // should not fill the card, so keep only the nearest per (customer, address).
  const seen = new Set<string>();
  const nearby: DossierNearbyJob[] = [];
  for (const r of within) {
    const key = `${r.customerName ?? ""}|${r.address ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    nearby.push(r);
    if (nearby.length >= DOSSIER_NEARBY_LIMIT) break;
  }

  // Street count: exact normalized-street match over the ILIKE candidates
  // ("Elm St" must not count "Helm St"). Without an address, fall back to the
  // uncapped count of distinct nearby households within 250 m.
  const street = normalizeStreetName(address);
  let roofsOnStreet: number;
  if (street) {
    roofsOnStreet = streetAddresses.filter((a) => normalizeStreetName(a) === street).length;
  } else {
    const households = new Set(within.map((r) => `${r.customerName ?? ""}|${r.address ?? ""}`));
    roofsOnStreet = households.size;
  }

  const priorKnockRow = knockRows
    .filter((k) => canvassHaversineMeters(lat, lng, k.lat, k.lng) <= DOSSIER_SAME_DOOR_METERS)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

  return {
    roofsOnStreet,
    nearby,
    priorKnock: priorKnockRow
      ? { outcome: priorKnockRow.outcome, ts: priorKnockRow.createdAt.toISOString(), repName: priorKnockRow.repName }
      : null,
    isExistingCustomer: within.some((r) => r.distanceM <= DOSSIER_SAME_DOOR_METERS),
  };
}
