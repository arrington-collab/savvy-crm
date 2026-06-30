// US Census one-line geocoder. Free, no API key, US addresses only. Fail-soft:
// any error / no match returns null so callers never throw on a bad address.

const CENSUS_BASE = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";

export interface GeoPoint {
  lat: number;
  lng: number;
}

export async function geocode(address: string, fetchImpl: typeof fetch = fetch): Promise<GeoPoint | null> {
  try {
    const url = `${CENSUS_BASE}?address=${encodeURIComponent(address)}&benchmark=Public_AR_Current&format=json`;
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const d = (await res.json()) as {
      result?: { addressMatches?: { coordinates?: { x: number; y: number } }[] };
    };
    const c = d.result?.addressMatches?.[0]?.coordinates;
    // Census returns x=longitude, y=latitude.
    return c && typeof c.x === "number" && typeof c.y === "number" ? { lat: c.y, lng: c.x } : null;
  } catch {
    return null;
  }
}
