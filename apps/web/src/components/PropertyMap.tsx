import { staticMapImageUrl, mapsPlaceLinkUrl } from "@savvy/core";

const KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "";

interface PropertyMapProps {
  address: string | null;
  lat: number | null;
  lng: number | null;
  className?: string;
}

/** Aerial static-map thumbnail (server component). Links out to Google Maps.
 *  Renders nothing when there is no API key or no location. */
export function PropertyMap({ address, lat, lng, className }: PropertyMapProps) {
  // zoom 20 ≈ single-property level: close enough to read the roof itself
  const img = staticMapImageUrl({ apiKey: KEY, lat, lng, address, zoom: 20 });
  const link = mapsPlaceLinkUrl({ lat, lng, address });
  if (!img || !link) return null;
  return (
    <a
      href={link}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      data-testid="property-map-link"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={img}
        loading="lazy"
        alt={`Map of ${address ?? "property"}`}
        width={600}
        height={300}
        className="w-full rounded-md border"
        data-testid="property-map-img"
      />
    </a>
  );
}
