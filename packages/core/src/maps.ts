export interface StaticMapInput {
  apiKey: string;
  lat?: number | null;
  lng?: number | null;
  address?: string | null;
  zoom?: number;
  width?: number;
  height?: number;
  scale?: number;
  maptype?: "hybrid" | "satellite" | "roadmap";
}

/** Resolve a single location string: "lat,lng" when both are finite, else a
 *  non-empty trimmed address, else null. */
function locationParam(
  lat?: number | null,
  lng?: number | null,
  address?: string | null,
): string | null {
  if (
    typeof lat === "number" && Number.isFinite(lat) &&
    typeof lng === "number" && Number.isFinite(lng)
  ) {
    return `${lat},${lng}`;
  }
  const a = address?.trim();
  return a ? a : null;
}

/** Build a Google Maps Static API image URL with one red marker. Prefers
 *  lat,lng; falls back to the address (the API geocodes it server-side).
 *  Returns null when there is no apiKey or no usable location. */
export function staticMapImageUrl(input: StaticMapInput): string | null {
  const {
    apiKey, lat, lng, address,
    zoom = 18, width = 600, height = 300, scale = 2, maptype = "hybrid",
  } = input;
  if (!apiKey) return null;
  const loc = locationParam(lat, lng, address);
  if (!loc) return null;
  const enc = encodeURIComponent(loc);
  const params = [
    `center=${enc}`,
    `zoom=${zoom}`,
    `size=${width}x${height}`,
    `scale=${scale}`,
    `maptype=${maptype}`,
    `markers=${encodeURIComponent(`color:red|${loc}`)}`,
    `key=${apiKey}`,
  ];
  return `https://maps.googleapis.com/maps/api/staticmap?${params.join("&")}`;
}

/** Build a https://www.google.com/maps/search/ link for the property. Prefers
 *  lat,lng; falls back to the address. Returns null with no location. */
export function mapsPlaceLinkUrl(loc: {
  lat?: number | null;
  lng?: number | null;
  address?: string | null;
}): string | null {
  const l = locationParam(loc.lat, loc.lng, loc.address);
  if (!l) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(l)}`;
}
