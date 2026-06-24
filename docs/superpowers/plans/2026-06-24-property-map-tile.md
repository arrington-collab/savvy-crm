# Property aerial-map tile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show an aerial (satellite/hybrid) static map thumbnail of the property — with a pin, linking out to Google Maps — on the lead Contact card (`/leads/[id]`) and the job header card (`/jobs/[id]`).

**Architecture:** Two pure URL builders in `@savvy/core` (unit-tested) assemble a Maps Static API image URL and a Google Maps link. A thin server component `PropertyMap` renders `<a><img></a>` using them, degrading to `null` when there's no API key or no location. Lead and job detail queries gain `lat`/`lng`; both pages render the component.

**Tech Stack:** TypeScript, Next.js (App Router, server components), Drizzle, Vitest (core unit tests), Playwright (e2e). Google Maps Static API (referrer-restricted browser key already in `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`).

---

## File structure

- Create: `packages/core/src/maps.ts` — `staticMapImageUrl`, `mapsPlaceLinkUrl` (pure).
- Create: `packages/core/src/maps.test.ts` — unit tests for both.
- Modify: `packages/core/src/index.ts` — re-export `./maps`.
- Create: `apps/web/src/components/PropertyMap.tsx` — server presentational component.
- Modify: `apps/web/src/lib/leads-queries.ts` — add `lat`/`lng` to the `getLeadDetail` select + `LeadDetail` type.
- Modify: `apps/web/src/app/(app)/leads/[id]/page.tsx` — render `<PropertyMap>` in the Contact card.
- Modify: `apps/web/src/app/(app)/jobs/[id]/page.tsx` — add `lat`/`lng` to the inline select + render `<PropertyMap>` in the header card.
- Modify: `apps/web/playwright.config.ts` — add `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` to the webServer env so the e2e renders the map.
- Create: `apps/web/tests/e2e/property-map.spec.ts` — e2e on the lead surface.

---

### Task 1: Pure URL builders in @savvy/core

**Files:**
- Create: `packages/core/src/maps.ts`
- Test: `packages/core/src/maps.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/maps.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { staticMapImageUrl, mapsPlaceLinkUrl } from "./maps";

describe("staticMapImageUrl", () => {
  it("uses lat,lng when both are finite", () => {
    const url = staticMapImageUrl({ apiKey: "K", lat: 33.5, lng: -112.06 });
    expect(url).toContain("https://maps.googleapis.com/maps/api/staticmap?");
    expect(url).toContain("center=33.5%2C-112.06");
    expect(url).toContain("markers=color%3Ared%7C33.5%2C-112.06");
    expect(url).toContain("maptype=hybrid");
    expect(url).toContain("zoom=18");
    expect(url).toContain("scale=2");
    expect(url).toContain("size=600x300");
    expect(url).toContain("key=K");
  });

  it("falls back to the address string when coords are missing", () => {
    const url = staticMapImageUrl({ apiKey: "K", lat: null, lng: null, address: "1600 E Camelback Rd, Phoenix" });
    expect(url).toContain("center=1600%20E%20Camelback%20Rd%2C%20Phoenix");
  });

  it("returns null with no apiKey", () => {
    expect(staticMapImageUrl({ apiKey: "", lat: 33.5, lng: -112.06 })).toBeNull();
  });

  it("returns null when there is no usable location", () => {
    expect(staticMapImageUrl({ apiKey: "K", lat: null, lng: null, address: "  " })).toBeNull();
  });

  it("ignores partial coords (lat only) and uses the address", () => {
    const url = staticMapImageUrl({ apiKey: "K", lat: 33.5, lng: null, address: "Phoenix" });
    expect(url).toContain("center=Phoenix");
  });
});

describe("mapsPlaceLinkUrl", () => {
  it("prefers lat,lng", () => {
    expect(mapsPlaceLinkUrl({ lat: 33.5, lng: -112.06 })).toBe(
      "https://www.google.com/maps/search/?api=1&query=33.5%2C-112.06",
    );
  });

  it("falls back to address", () => {
    expect(mapsPlaceLinkUrl({ address: "Phoenix, AZ" })).toBe(
      "https://www.google.com/maps/search/?api=1&query=Phoenix%2C%20AZ",
    );
  });

  it("returns null with no location", () => {
    expect(mapsPlaceLinkUrl({ lat: null, lng: null, address: null })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/Sites/savvy-crm && pnpm --filter @savvy/core exec vitest run src/maps.test.ts`
Expected: FAIL — `Failed to resolve import "./maps"` (module doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/maps.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/Sites/savvy-crm && pnpm --filter @savvy/core exec vitest run src/maps.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/Sites/savvy-mapfeature
git add packages/core/src/maps.ts packages/core/src/maps.test.ts
git commit -m "feat(core): static-map + maps-link URL builders"
```

---

### Task 2: Export from core + the PropertyMap component

**Files:**
- Modify: `packages/core/src/index.ts` (append one export line)
- Create: `apps/web/src/components/PropertyMap.tsx`

- [ ] **Step 1: Re-export the module**

Append to `packages/core/src/index.ts` (after the last `export * from "./install-recommendation";` line):

```ts
export * from "./maps";
```

- [ ] **Step 2: Verify the export resolves (typecheck core)**

Run: `cd ~/Sites/savvy-crm && pnpm --filter @savvy/core typecheck`
Expected: exit 0 (no output).

- [ ] **Step 3: Write the component**

Create `apps/web/src/components/PropertyMap.tsx`:

```tsx
import { staticMapImageUrl, mapsPlaceLinkUrl } from "@savvy/core";

interface PropertyMapProps {
  address: string | null;
  lat: number | null;
  lng: number | null;
  className?: string;
}

/** Aerial static-map thumbnail (server component). Links out to Google Maps.
 *  Renders nothing when there is no API key or no location. */
export function PropertyMap({ address, lat, lng, className }: PropertyMapProps) {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "";
  const img = staticMapImageUrl({ apiKey, lat, lng, address });
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
```

- [ ] **Step 4: Typecheck the web app**

Run: `cd ~/Sites/savvy-crm && pnpm --filter @savvy/web typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
cd ~/Sites/savvy-mapfeature
git add packages/core/src/index.ts apps/web/src/components/PropertyMap.tsx
git commit -m "feat(web): PropertyMap component + core export"
```

---

### Task 3: Wire the lead Contact card

**Files:**
- Modify: `apps/web/src/lib/leads-queries.ts` (select + `LeadDetail` type)
- Modify: `apps/web/src/app/(app)/leads/[id]/page.tsx` (render component)

- [ ] **Step 1: Add lat/lng to the select**

In `apps/web/src/lib/leads-queries.ts`, in the `getLeadDetail` `.select({ … })` object, add these two lines right after `address: property.address,`:

```ts
        lat: property.lat,
        lng: property.lng,
```

- [ ] **Step 2: Add lat/lng to the LeadDetail type**

In the same file, in the `export type LeadDetail = { … }`, add right after `address: string | null;`:

```ts
  lat: number | null;
  lng: number | null;
```

- [ ] **Step 3: Render the map in the Contact card**

In `apps/web/src/app/(app)/leads/[id]/page.tsx`:

(a) Add the import after the existing `import { LeadEnrichmentCard } …` line:

```ts
import { PropertyMap } from "@/components/PropertyMap";
```

(b) Inside the Contact `<Card>`, immediately after the `source:` paragraph (`<p … >source: {detail.source ?? "—"}</p>`), add:

```tsx
          <PropertyMap
            address={detail.address}
            lat={detail.lat}
            lng={detail.lng}
            className="mt-3 block"
          />
```

- [ ] **Step 4: Typecheck**

Run: `cd ~/Sites/savvy-crm && pnpm --filter @savvy/web typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
cd ~/Sites/savvy-mapfeature
git add apps/web/src/lib/leads-queries.ts "apps/web/src/app/(app)/leads/[id]/page.tsx"
git commit -m "feat(web): aerial map on lead Contact card"
```

---

### Task 4: Wire the job header card

**Files:**
- Modify: `apps/web/src/app/(app)/jobs/[id]/page.tsx` (select + render)

- [ ] **Step 1: Add lat/lng to the inline select**

In `apps/web/src/app/(app)/jobs/[id]/page.tsx`, in the `.select({ … })` object, add right after `address: property.address,`:

```ts
        lat: property.lat,
        lng: property.lng,
```

- [ ] **Step 2: Add the import**

After the existing component imports near the top (e.g. after the `Card` import line), add:

```ts
import { PropertyMap } from "@/components/PropertyMap";
```

- [ ] **Step 3: Render the map in the header card**

In the header `<Card className="p-5">`, inside the `<div className="space-y-1">`, immediately after the email/phone `<p>` block (the `{(jobRow.customerEmail || jobRow.customerPhone) && ( … )}` expression), add:

```tsx
            <PropertyMap
              address={jobRow.address}
              lat={jobRow.lat}
              lng={jobRow.lng}
              className="mt-3 block max-w-md"
            />
```

- [ ] **Step 4: Typecheck**

Run: `cd ~/Sites/savvy-crm && pnpm --filter @savvy/web typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
cd ~/Sites/savvy-mapfeature
git add "apps/web/src/app/(app)/jobs/[id]/page.tsx"
git commit -m "feat(web): aerial map on job header card"
```

---

### Task 5: e2e — map renders on lead detail

**Files:**
- Modify: `apps/web/playwright.config.ts` (webServer env)
- Create: `apps/web/tests/e2e/property-map.spec.ts`

- [ ] **Step 1: Ensure the key is present for the dev server**

In `apps/web/playwright.config.ts`, find the `webServer.env` object and add this entry (a dummy value is fine — the test only asserts the URL shape, not that Google serves the image):

```ts
      NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: "test-maps-key",
```

- [ ] **Step 2: Write the e2e test**

Create `apps/web/tests/e2e/property-map.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { withTenant, customer, property, lead } from "@savvy/db";

const { id: tenantId } = JSON.parse(
  readFileSync("/tmp/savvy-e2e-tenant.json", "utf8"),
) as { id: string };

test("property map renders on lead detail with coords", async ({ page }) => {
  const leadId = await withTenant(tenantId, async (tx) => {
    const [c] = await tx
      .insert(customer)
      .values({ tenantId, name: "Map Lead", phone: "+15555550000" })
      .returning();
    const [p] = await tx
      .insert(property)
      .values({
        tenantId,
        customerId: c!.id,
        address: "1600 E Camelback Rd, Phoenix, AZ",
        lat: 33.5092,
        lng: -112.0633,
      })
      .returning();
    const [l] = await tx
      .insert(lead)
      .values({ tenantId, customerId: c!.id, propertyId: p!.id, status: "new", source: "seed" })
      .returning();
    return l!.id;
  });

  await page.goto(`/leads/${leadId}`);
  const img = page.getByTestId("property-map-img");
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute(
    "src",
    /^https:\/\/maps\.googleapis\.com\/maps\/api\/staticmap\?/,
  );
  await expect(page.getByTestId("property-map-link")).toHaveAttribute(
    "href",
    /^https:\/\/www\.google\.com\/maps\/search\//,
  );
});
```

- [ ] **Step 3: Run the e2e**

Run: `cd ~/Sites/savvy-crm && pnpm --filter @savvy/web exec playwright test property-map.spec.ts`
Expected: PASS (the map image element is present with a Static API src; the link points at Google Maps).

- [ ] **Step 4: Commit**

```bash
cd ~/Sites/savvy-mapfeature
git add apps/web/playwright.config.ts apps/web/tests/e2e/property-map.spec.ts
git commit -m "test(web): e2e for property map on lead detail"
```

---

### Task 6: Full gate

- [ ] **Step 1: Typecheck + lint + core unit tests**

Run: `cd ~/Sites/savvy-crm && pnpm typecheck && pnpm --filter @savvy/core exec vitest run src/maps.test.ts && pnpm --filter @savvy/web lint`
Expected: typecheck exit 0; 8 unit tests pass; lint 0 errors (pre-existing warnings in other files are acceptable).

- [ ] **Step 2: Push the branch and open a PR**

```bash
cd ~/Sites/savvy-mapfeature
git push -u origin feat/property-map-tile
gh pr create --base main --title "feat: aerial property map on lead + job tiles" --body "Implements docs/superpowers/specs/2026-06-24-property-map-tile-design.md. Static Maps API aerial thumbnail with a pin on the lead Contact card and job header card, linking to Google Maps. Pure URL builders in @savvy/core (8 unit tests) + thin server component; degrades to no-map without key/location."
```

- [ ] **Step 3: Confirm CI is green**

Run: `gh pr checks --watch`
Expected: build + e2e pass. Fix-forward if red.

---

## Notes for the implementer

- **Prerequisite (not a code step):** the "Maps Static API" product must be enabled on the existing `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` in Google Cloud. The app works without it (degrades to no map / broken image), and the e2e uses a dummy key + URL-shape assertions, so this does not block the build — it only matters for the live image rendering.
- `property.lat`/`property.lng` are `doublePrecision` columns → `number | null` in Drizzle selects.
- Do NOT switch to `next/image` — it would require configuring `images.remotePatterns` for `maps.googleapis.com`. A plain `<img>` with the eslint-disable comment is intentional.
- This worktree (`~/Sites/savvy-mapfeature`, branch `feat/property-map-tile`) is off `origin/main` and independent of the concurrent `feat/storm-cert-on-lead` work and of PR #38 (lead-intake) — no file overlap.
