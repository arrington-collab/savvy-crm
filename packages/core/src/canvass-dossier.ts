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

// ── Phase 2: StormProof storm history + roof age/material ────────────────
// The gateway lives in @savvy/integrations; core only sees structural types so
// there is no core→integrations dependency. The route feeds real gateway
// results (or cached payloads) through these shapers.

export const DOSSIER_STORM_MONTHS = 24;
export const DOSSIER_STORM_TTL_DAYS = 7;
export const DOSSIER_PROPERTY_TTL_DAYS = 30;

// Cache key: coordinates rounded to 4 decimals (~11 m — door-level). The spec
// suggested ~5, but 5 dp is ~1.1 m, tighter than map-tap/GPS jitter, which
// would defeat the cache on repeat knocks at the same door.
export function dossierCoordKey(lat: number, lng: number): string {
  return `${lat.toFixed(4)},${lng.toFixed(4)}`;
}

export function dossierCacheFresh(fetchedAt: Date, ttlDays: number, now = new Date()): boolean {
  return now.getTime() - fetchedAt.getTime() < ttlDays * 86_400_000;
}

export interface StormEventLike {
  date: string;
  eventType: "hail" | "wind";
  size?: number;
  windMph?: number;
}

export interface StormSummaryLike {
  events: StormEventLike[];
  eventCount: number;
  maxHailInches: number;
  maxWindMph: number;
  daysSinceWorst: number | null;
}

export interface PropertyDataLike {
  yearBuilt: number | null;
  roofAge: number | null;
  roofType: string | null;
  supported: boolean;
}

export interface DossierStorm {
  worstDate: string | null;
  hailInches: number | null;
  windMph: number | null;
  daysSince: number | null;
  eventCount: number;
}

export interface DossierProperty {
  roofAgeYears: number | null;
  roofType: string | null;
  yearBuilt: number | null;
  supported: true;
}

// worstDate is the date of the event the CARD describes — hail-first (the
// sales-relevant peril; the card only falls back to wind when there's no
// hail), NOT the gateway's hail*10+wind worst-event scoring, which would let
// a strong wind event's date sit next to the max-hail size and mislead reps.
export function shapeDossierStorm(s: StormSummaryLike | null | undefined): DossierStorm | null {
  if (!s || s.eventCount === 0) return null;
  const biggest = (type: "hail" | "wind") =>
    s.events
      .filter((e) => e.eventType === type)
      .sort((a, b) => (type === "hail" ? (b.size ?? 0) - (a.size ?? 0) : (b.windMph ?? 0) - (a.windMph ?? 0)))[0] ?? null;
  const worst = s.maxHailInches > 0 ? biggest("hail") : biggest("wind");
  return {
    worstDate: worst?.date ? worst.date.slice(0, 10) : null,
    hailInches: s.maxHailInches > 0 ? s.maxHailInches : null,
    windMph: s.maxWindMph > 0 ? s.maxWindMph : null,
    daysSince: s.daysSinceWorst,
    eventCount: s.eventCount,
  };
}

export function shapeDossierProperty(p: PropertyDataLike | null | undefined): DossierProperty | null {
  if (!p || !p.supported) return null;
  if (p.roofAge == null && p.roofType == null && p.yearBuilt == null) return null;
  return { roofAgeYears: p.roofAge, roofType: p.roofType, yearBuilt: p.yearBuilt, supported: true };
}
