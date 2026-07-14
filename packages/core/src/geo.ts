export type GeoPoint = { lat: number; lng: number };

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
