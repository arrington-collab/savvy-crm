// Strike List slice 1 — the county-assessor ingestion seam. DORMANT by default:
// no county API is wired here; the default feed is a no-op until a real adapter
// (starting with Maricopa) is constructed with a live raw-row fetcher. Mirrors
// the EmailFinder seam pattern — one interface, dormant + fake + real adapters.

import type { RoofMaterial } from "@savvy/core";

/** One parcel of county roof data, normalized to Savvy's vocabulary. */
export interface AssessorParcel {
  parcelId: string;
  address: string;
  roofMaterial: RoofMaterial | null;
  yearBuilt: number | null;
  subdivision: string | null;
}

export interface AssessorFeed {
  fetchParcels(o: { county: string; since?: Date }): Promise<AssessorParcel[]>;
}

/** Inert feed — always empty. Wiring a county replaces this default. */
export function makeDormantAssessorFeed(): AssessorFeed {
  return { async fetchParcels() { return []; } };
}

export function makeFakeAssessorFeed(parcels: AssessorParcel[]): AssessorFeed {
  return { async fetchParcels() { return parcels; } };
}

export const assessorFeed: AssessorFeed = makeDormantAssessorFeed();

// --- Maricopa County adapter -------------------------------------------------

// The assessor exposes a "roof cover" string; map it onto the structured
// vocabulary. Keys are normalized (lowercased, single-spaced) before lookup.
const MARICOPA_ROOF_COVER: Record<string, RoofMaterial> = {
  "wood shake": "wood_shake",
  "shake": "wood_shake",
  "clay tile": "clay_tile",
  "tile": "clay_tile",
  "concrete tile": "concrete_tile",
  "comp shingle": "asphalt_shingle",
  "composition shingle": "asphalt_shingle",
  "shingle": "asphalt_shingle",
  "built-up": "flat_builtup",
  "built up": "flat_builtup",
  "foam": "flat_builtup",
  "metal": "metal",
};

export function mapMaricopaRoofCover(cover: string | null | undefined): RoofMaterial {
  const key = (cover ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return MARICOPA_ROOF_COVER[key] ?? "other";
}

/** Raw Maricopa parcel row (subset of the assessor export columns we consume). */
export interface MaricopaRawParcel {
  PARCEL: string;
  SITUS_ADDRESS: string;
  ROOF_COVER?: string | null;
  YEAR_BUILT?: string | number | null;
  SUBDIVISION?: string | null;
}

export function normalizeMaricopaParcel(raw: MaricopaRawParcel): AssessorParcel {
  const year = raw.YEAR_BUILT == null || raw.YEAR_BUILT === "" ? null : Number(raw.YEAR_BUILT);
  return {
    parcelId: raw.PARCEL,
    address: raw.SITUS_ADDRESS,
    roofMaterial: mapMaricopaRoofCover(raw.ROOF_COVER),
    yearBuilt: year != null && Number.isFinite(year) ? year : null,
    subdivision: raw.SUBDIVISION?.trim() || null,
  };
}

/** Build a Maricopa feed from an injected raw-row source (the real HTTP/bulk
 *  fetcher is supplied by the caller; dormant until one exists). */
export function makeMaricopaAssessorFeed(
  fetchRaw: (o: { county: string; since?: Date }) => Promise<MaricopaRawParcel[]>,
): AssessorFeed {
  return {
    async fetchParcels(o) {
      const rows = await fetchRaw(o);
      return rows.map(normalizeMaricopaParcel);
    },
  };
}
