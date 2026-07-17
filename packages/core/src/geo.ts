export type GeoPoint = { lat: number; lng: number };

// Reuse the existing great-circle helper rather than duplicating it.
import { haversineMeters } from "./scheduling";

/** Closest candidate to `point` within `radiusMeters`, or null. Candidates with
 *  missing coordinates are skipped. Used to match a tagger pin (a map tap) to
 *  the nearest known property when there's no parcel polygon to fall inside. */
export function nearestWithin<T extends { lat: number | null; lng: number | null }>(
  point: GeoPoint,
  candidates: readonly T[],
  radiusMeters: number,
): T | null {
  let best: T | null = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    if (c.lat == null || c.lng == null) continue;
    const d = haversineMeters(point, { lat: c.lat, lng: c.lng });
    if (d <= radiusMeters && d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best;
}

/** Ray-casting point-in-polygon (lat/lng treated as planar — fine at storm-swath
 *  scale). Used to intersect verified storm swaths with baselined properties. */
export function pointInPolygon(point: GeoPoint, polygon: GeoPoint[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    const intersects =
      (a.lng > point.lng) !== (b.lng > point.lng) &&
      point.lat < ((b.lat - a.lat) * (point.lng - a.lng)) / (b.lng - a.lng) + a.lat;
    if (intersects) inside = !inside;
  }
  return inside;
}
