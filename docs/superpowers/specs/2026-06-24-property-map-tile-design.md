# Property aerial-map tile — design

**Date:** 2026-06-24
**Status:** Approved (design)

## Goal

Show an aerial (satellite) map thumbnail of the property on the **lead detail** Contact tile (`/leads/[id]`) and the **job detail** header card (`/jobs/[id]`). The thumbnail has a pin at the property and links out to Google Maps on click. For a roofing CRM this lets a rep/manager see the actual roof at a glance.

## Approach

Use Google's **Maps Static API** rendered as a plain `<img>` wrapped in an anchor. No Maps JavaScript, no client component — one image request per detail-page view. Lightweight, cheap, and degrades to "no map" cleanly.

Rejected alternatives:
- **Interactive embedded map** (Maps JavaScript / Embed API): richer but loads JS per page, higher cost, more moving parts. Not worth it for a thumbnail.
- **Road map instead of aerial**: loses the roof view, which is the point for roofing.

## Components

### 1. Pure URL builders — `packages/core/src/maps.ts`

Two pure functions (the unit-tested core; no I/O, no env access inside them):

```ts
interface StaticMapInput {
  apiKey: string;
  lat?: number | null;
  lng?: number | null;
  address?: string | null;
  zoom?: number;      // default 18
  width?: number;     // default 600
  height?: number;    // default 300
  scale?: number;     // default 2 (retina)
  maptype?: "hybrid" | "satellite" | "roadmap"; // default "hybrid"
}

// Returns a maps.googleapis.com/maps/api/staticmap?... URL with a single red
// marker. Prefers lat,lng; falls back to the address string (Static API
// geocodes it server-side). Returns null when there is no usable location
// (no coords AND no address) or no apiKey.
function staticMapImageUrl(input: StaticMapInput): string | null;

// Returns a https://www.google.com/maps/search/?api=1&query=... link.
// Prefers lat,lng; falls back to address. Returns null when neither present.
function mapsPlaceLinkUrl(loc: { lat?: number | null; lng?: number | null; address?: string | null }): string | null;
```

- Location precedence in both: `lat,lng` when **both** are finite numbers, else a non-empty `address`, else `null`.
- All user-derived values (`address`) are `encodeURIComponent`-escaped into query params.
- `maptype=hybrid` = satellite imagery + street/place labels (better orientation than raw `satellite`).
- Marker: `markers=color:red|<location>`.

Exported from `@savvy/core` via `packages/core/src/index.ts`.

### 2. Presentational component — `apps/web/src/components/PropertyMap.tsx`

Server component (no `"use client"` — output is just `<a><img></a>`).

```ts
interface PropertyMapProps {
  address: string | null;
  lat: number | null;
  lng: number | null;
  className?: string;
}
```

Behavior:
- Reads `process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`.
- Builds the image URL via `staticMapImageUrl` and the link via `mapsPlaceLinkUrl`.
- If the image URL is `null` (no key / no location) → **return `null`** (the tile renders exactly as it does today). Mirrors the `AddressAutocomplete` degrade-without-key pattern.
- Otherwise renders:
  ```tsx
  <a href={link} target="_blank" rel="noopener noreferrer" className={className} data-testid="property-map-link">
    <img src={img} loading="lazy" alt={`Map of ${address ?? "property"}`}
         width={600} height={300} className="w-full rounded-md border" data-testid="property-map-img" />
  </a>
  ```
- `loading="lazy"` so off-screen maps don't fetch until needed.

### 3. Wiring

**Lead detail** (`apps/web/src/app/(app)/leads/[id]/page.tsx` + `apps/web/src/lib/leads-queries.ts`):
- Add `lat: property.lat, lng: property.lng` to the `getLeadDetail` select and to the `LeadDetail` type.
- In the Contact `<Card>`, after the `source:` line, render `<PropertyMap address={detail.address} lat={detail.lat} lng={detail.lng} className="mt-3 block" />`.

**Job detail** (`apps/web/src/app/(app)/jobs/[id]/page.tsx`):
- Add `lat: property.lat, lng: property.lng` to the page's inline select.
- In the header `<Card>`, after the email/phone line, render `<PropertyMap address={jobRow.address} lat={jobRow.lat} lng={jobRow.lng} className="mt-3 block max-w-md" />`.

## Data flow

`property.lat/lng` (populated by `AddressAutocomplete` at lead creation) → query select → page → `<PropertyMap>` → `staticMapImageUrl` builds the `<img src>` → browser fetches the image directly from Google (referrer-restricted key) → click → `mapsPlaceLinkUrl` opens Google Maps in a new tab.

Old leads/jobs without coordinates still get a map because the Static API geocodes the `address` fallback string. Records with neither coords nor address show no map (component returns null).

## Security / cost

- The API key is the existing public, **referrer-restricted** browser key. It appears in the `<img>` URL by design; the `savvy-crm.vercel.app/*` HTTP-referrer restriction is what protects it. No URL signing needed.
- No SSRF surface: the host is the fixed `maps.googleapis.com`; `address` only enters URL-encoded query params.
- Cost: one Maps Static API load per lead/job detail view. `loading="lazy"` avoids fetching when the tile is off-screen.

## Prerequisite (config, outside this change)

The **"Maps Static API"** must be enabled on the existing key in Google Cloud (separate product from Places / Maps JavaScript). The new `savvy-crm.vercel.app/*` referrer restriction already covers it.

## Testing

- **Unit (vitest, `packages/core/src/maps.test.ts`)**: `staticMapImageUrl` and `mapsPlaceLinkUrl` —
  - prefers `lat,lng` when both finite;
  - falls back to `address` when coords missing;
  - returns `null` when no location, or (image) no apiKey;
  - URL-encodes the address;
  - includes `maptype=hybrid`, `zoom`, `scale`, `size`, and a `markers` param.
- **e2e (Playwright)**: seed a lead with `lat`/`lng` (direct insert, like `leads.spec.ts`), open `/leads/[id]`, assert `property-map-img` `src` starts with `https://maps.googleapis.com/maps/api/staticmap` and `property-map-link` `href` starts with `https://www.google.com/maps/search/`. Job surface relies on the shared component being covered by the lead e2e.

## Out of scope

Interactive maps, multiple markers, directions, Street View, draw-the-roof, per-tenant map styling, storing/caching the geocoded result.
