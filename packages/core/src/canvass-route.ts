// Routing for the canvass "Recently Sold" layer: a rep drops a pin, takes the
// nearest 15 or 25 sold homes, and gets a sensible walking/driving order.
//
// Straight-line (haversine) distance on purpose. A road-routing API costs per
// request, needs a key, and breaks offline — and Phoenix is a near-perfect
// street grid, so straight-line order matches driving order for all but a stop
// or two out of 25. Not worth the dependency.

export const SOLD_STATUSES = ["new", "goback", "notint", "appt", "customer", "dnk"] as const;
export type SoldStatus = (typeof SOLD_STATUSES)[number];

/** Counts a rep may claim in one go. */
export const SOLD_CLAIM_COUNTS = [15, 25] as const;

/**
 * How far a claim may reach. Without a cap, "nearest 25" in a sparse area drags
 * a rep across the Valley — returning fewer homes is strictly better than
 * returning a nonsense route.
 */
export const SOLD_CLAIM_RADIUS_MILES = 5;

/** A claim is released automatically this long after it was made. */
export const SOLD_CLAIM_RELEASE_DAYS = 30;

/** Not-interested signs stop cluttering the map after this many days. */
export const SOLD_NOTINT_HIDE_DAYS = 7;

/** Only these mean "a rep should still walk up to this door". */
export function isClaimableStatus(status: string): boolean {
  return status === "new" || status === "goback";
}

/**
 * Whether a sign should render. `notint` fades out after a week so the map
 * doesn't fill with dead doors; `dnk` NEVER hides — it exists precisely to stop
 * the next rep knocking there.
 */
export function soldVisible(
  row: { status: string; statusAt: string | Date },
  now: number = Date.now(),
): boolean {
  if (row.status !== "notint") return true;
  const at = row.statusAt instanceof Date ? row.statusAt.getTime() : Date.parse(String(row.statusAt));
  if (!Number.isFinite(at)) return true; // unparseable → show it rather than lose it
  return now - at < SOLD_NOTINT_HIDE_DAYS * 86400000;
}

export interface RoutePoint { id: string; lat: number; lng: number }
export interface RouteStart { lat: number; lng: number }

const EARTH_RADIUS_MILES = 3958.7613;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversineMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Total distance of an ordered route, including the leg from the rep's start. */
export function routeLengthMiles(points: RoutePoint[], start: RouteStart): number {
  if (points.length === 0) return 0;
  let total = haversineMiles(start.lat, start.lng, points[0]!.lat, points[0]!.lng);
  for (let i = 1; i < points.length; i++) {
    total += haversineMiles(points[i - 1]!.lat, points[i - 1]!.lng, points[i]!.lat, points[i]!.lng);
  }
  return total;
}

/**
 * Nearest-neighbour seeded from the rep's position, then 2-opt.
 *
 * Greedy alone reliably strands one outlying house and doubles back for it at
 * the end; 2-opt uncrosses those segments and typically cuts 10-20% of the
 * distance at this size. At 25 stops it runs in milliseconds, so it can happen
 * inline on a claim.
 *
 * Deterministic: no randomness, no time dependence — the same input always
 * yields the same order, which keeps stored routeSeq reproducible.
 */
export function optimizeRoute(points: RoutePoint[], start: RouteStart): RoutePoint[] {
  if (points.length <= 1) return [...points];

  // --- nearest neighbour ---
  const remaining = [...points];
  const order: RoutePoint[] = [];
  let cur: RouteStart = start;
  while (remaining.length) {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversineMiles(cur.lat, cur.lng, remaining[i]!.lat, remaining[i]!.lng);
      if (d < bestD) { bestD = d; best = i; }
    }
    const [next] = remaining.splice(best, 1);
    order.push(next!);
    cur = next!;
  }

  // --- 2-opt: reverse any segment whose removal shortens the path ---
  // Open path (no return to start), so only the reversed span's endpoints move.
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 50) {
    improved = false;
    for (let i = 0; i < order.length - 1; i++) {
      for (let k = i + 1; k < order.length; k++) {
        const a = i === 0 ? start : order[i - 1]!;
        const b = order[i]!;
        const c = order[k]!;
        const d = order[k + 1];
        const before =
          haversineMiles(a.lat, a.lng, b.lat, b.lng) +
          (d ? haversineMiles(c.lat, c.lng, d.lat, d.lng) : 0);
        const after =
          haversineMiles(a.lat, a.lng, c.lat, c.lng) +
          (d ? haversineMiles(b.lat, b.lng, d.lat, d.lng) : 0);
        if (after < before - 1e-12) {
          reverseInPlace(order, i, k);
          improved = true;
        }
      }
    }
  }

  return order;
}

function reverseInPlace<T>(arr: T[], i: number, k: number): void {
  while (i < k) {
    const t = arr[i]!;
    arr[i] = arr[k]!;
    arr[k] = t;
    i++; k--;
  }
}
