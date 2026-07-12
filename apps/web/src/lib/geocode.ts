import "server-only";

// Reverse-geocoding providers, shared by /api/canvass/geocode (knock modal
// address) and /api/canvass/storms (hot-cell enrichment — Maricopa's assessor
// is address-based, so target cells need an address before a year-built).
export type Geo = { address: string | null; label: string | null };

export async function viaMapTiler(lat: number, lng: number, key: string): Promise<Geo | null> {
  const u = new URL(`https://api.maptiler.com/geocoding/${lng},${lat}.json`);
  u.searchParams.set("key", key);
  u.searchParams.set("types", "address");
  u.searchParams.set("limit", "1");
  const res = await fetch(u);
  if (!res.ok) return null;
  const d = (await res.json()) as { features?: { text?: string; address?: string; place_name?: string }[] };
  const f = d.features?.[0];
  if (!f) return { address: null, label: null };
  const address = [f.address, f.text].filter(Boolean).join(" ") || null;
  const label = f.place_name ? f.place_name.split(",").slice(0, 2).join(",") : address;
  return { address, label };
}

export async function viaNominatim(lat: number, lng: number): Promise<Geo | null> {
  const u = new URL("https://nominatim.openstreetmap.org/reverse");
  u.searchParams.set("format", "jsonv2");
  u.searchParams.set("lat", String(lat));
  u.searchParams.set("lon", String(lng));
  // OSM policy requires an identifying UA; the browser default from phones was neither
  const res = await fetch(u, { headers: { "User-Agent": "savvy-canvass/1.0 (support@getsavvy.com)" } });
  if (!res.ok) return null;
  const d = (await res.json()) as { address?: { house_number?: string; road?: string }; display_name?: string };
  const address = [d.address?.house_number, d.address?.road].filter(Boolean).join(" ") || null;
  const label = address || (d.display_name ? d.display_name.split(",").slice(0, 2).join(",") : null);
  return { address, label };
}

/** Provider pick: MapTiler when the key is configured, else Nominatim. */
export async function reverseGeocode(lat: number, lng: number): Promise<Geo | null> {
  const key = process.env.MAPTILER_API_KEY;
  try {
    return key ? await viaMapTiler(lat, lng, key) : await viaNominatim(lat, lng);
  } catch {
    return null;
  }
}
