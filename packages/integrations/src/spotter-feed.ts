// Strike List slice 2 — the Roof Tagger ingestion seam. DORMANT by default:
// the tagger (bloomroofs.vercel.app) is a separate app with its own DB, and no
// pull adapter ships here yet. Wiring the real feed is a follow-up — either a
// minimal export endpoint added to the tagger repo or a direct read replica —
// decided once that repo's data layer is in reach. Mirrors AssessorFeed.

import type { RoofMaterial } from "@savvy/core";

/** One human-tagged roof from the Roof Tagger app, normalized to Savvy shapes. */
export interface SpotterPin {
  externalId: string; // the tagger app's pin id — the idempotency key
  lat: number;
  lng: number;
  materialTag: RoofMaterial | null; // null = the spotter tagged debris/route but not a material
  hasDebris: boolean;
  spotterName: string | null;
  taggedAt: Date | null;
  address?: string | null; // present only if the tagger reverse-geocoded the tap
}

export interface SpotterFeed {
  fetchPins(o: { since?: Date }): Promise<SpotterPin[]>;
}

/** Inert feed — always empty. Wiring the tagger replaces this default. */
export function makeDormantSpotterFeed(): SpotterFeed {
  return { async fetchPins() { return []; } };
}

export function makeFakeSpotterFeed(pins: SpotterPin[]): SpotterFeed {
  return { async fetchPins() { return pins; } };
}

export const spotterFeed: SpotterFeed = makeDormantSpotterFeed();
