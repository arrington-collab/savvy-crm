export type StormEvent = {
  date: string;
  eventType: "hail" | "wind";
  size?: number;
  windMph?: number;
  id?: string;
  /** True when the queried point sits INSIDE the storm swath (vs merely nearby).
      Absent (legacy events-shaped payloads, fakes) is treated as at-point. */
  atPoint?: boolean;
};
export type PropertyData = { yearBuilt: number | null; roofAge: number | null; roofType: string | null; county: string | null; supported: boolean };
export type StormSummary = {
  events: StormEvent[]; eventCount: number;
  maxHailInches: number; maxWindMph: number;
  daysSinceWorst: number | null; worstEventId: string | null;
};
export type StormCertResult = {
  verified: boolean;
  certId?: string;
  pdfBase64?: string;
  verifyUrl?: string;
  storm?: { date: string; eventType: "hail" | "wind"; size?: number | null; windMph?: number | null };
  checkedMonths: number;
};

export interface StormProofGateway {
  getProperty(o: { lat?: number; lng?: number; address?: string }): Promise<PropertyData | null>;
  lookupStorms(o: { lat?: number; lng?: number; address?: string; months?: number }): Promise<StormSummary>;
  /** Raw verified swath tracks (for the map overlay). Fail-soft to []. */
  lookupStormTracks(o: { lat?: number; lng?: number; months?: number }): Promise<VerifiedTrack[]>;
  generateCertificate(o: { address?: string; lat?: number; lng?: number; months?: number }): Promise<StormCertResult>;
}

const BASE = () => process.env.STORMPROOF_API_BASE ?? "";
const headers = (): Record<string, string> => {
  const k = process.env.STORMPROOF_API_KEY;
  return k ? { "x-api-key": k } : {};
};

const EMPTY_STORMS: StormSummary = { events: [], eventCount: 0, maxHailInches: 0, maxWindMph: 0, daysSinceWorst: null, worstEventId: null };

export const httpStormProof: StormProofGateway = {
  async getProperty({ lat, lng, address }) {
    if (lat == null || lng == null) return null;
    try {
      const u = new URL(`${BASE()}/api/property`);
      u.searchParams.set("lat", String(lat));
      u.searchParams.set("lng", String(lng));
      if (address) u.searchParams.set("address", address);
      const res = await fetch(u, { headers: headers() });
      if (!res.ok) return null;
      const d = (await res.json()) as Record<string, unknown>;
      const yearBuilt = typeof d.yearBuilt === "number" ? d.yearBuilt : null;
      return {
        yearBuilt,
        roofAge: typeof d.roofAge === "number" ? d.roofAge : (yearBuilt ? new Date().getFullYear() - yearBuilt : null),
        roofType: typeof d.roofType === "string" ? d.roofType : null,
        county: typeof d.county === "string" ? d.county : null,
        supported: Boolean(d.supported),
      };
    } catch { return null; }
  },
  async lookupStorms({ lat, lng, months = 12 }) {
    try {
      // Only coords supported — address-only has no lat/lng to pass to /api/storms/verified
      if (lat == null || lng == null) return EMPTY_STORMS;
      const u = new URL(`${BASE()}/api/storms/verified`);
      u.searchParams.set("lat", String(lat));
      u.searchParams.set("lng", String(lng));
      u.searchParams.set("months", String(months));
      const res = await fetch(u, { headers: headers() });
      if (!res.ok) return EMPTY_STORMS;
      // /api/storms/verified returns IEM+SPC swath TRACKS ({tracks:[{rings,…}]}),
      // not flat events — reading d.events here meant the storm block was empty
      // for every address on earth. Parse tracks; keep the events shape as a
      // fallback for older payloads.
      const d = (await res.json()) as { tracks?: VerifiedTrack[]; events?: StormEvent[] };
      const events = d.events ?? parseVerifiedTracks(d.tracks ?? [], lat, lng);
      return summarize(events);
    } catch { return EMPTY_STORMS; }
  },
  async lookupStormTracks({ lat, lng, months = 24 }) {
    try {
      if (lat == null || lng == null) return [];
      const u = new URL(`${BASE()}/api/storms/verified`);
      u.searchParams.set("lat", String(lat));
      u.searchParams.set("lng", String(lng));
      u.searchParams.set("months", String(months));
      const res = await fetch(u, { headers: headers() });
      if (!res.ok) return [];
      const d = (await res.json()) as { tracks?: VerifiedTrack[] };
      return d.tracks ?? [];
    } catch { return []; }
  },
  async generateCertificate({ address, lat, lng, months = 24 }) {
    const res = await fetch(`${BASE()}/api/leads/certify`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers() },
      body: JSON.stringify({ address, lat, lng, months }),
    });
    if (!res.ok) throw new Error(`storm-scout certify failed (${res.status})`);
    return (await res.json()) as StormCertResult;
  },
};

// One merged IEM+SPC storm track from /api/storms/verified. Rings are swath
// polygons as [lat,lng] vertex arrays; size = max hail inches, windMph = max gust.
export type VerifiedTrack = {
  rings?: number[][][];
  center?: { lat: number; lng: number };
  eventType: "hail" | "wind";
  size?: number | null;
  windMph?: number | null;
  date: string;
};

// Tracks come back within the API's search radius (up to ~50 mi for hail),
// which is far too wide to claim "verified hail at this door". Keep a track when
// the point is INSIDE one of its swath rings (atPoint) or its center is within
// ~10 mi — the field card words those two cases differently.
export const STORM_NEARBY_MILES = 10;

export function pointInRing(lat: number, lng: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i]!;
    const [yj, xj] = ring[j]!;
    if (yi === undefined || xi === undefined || yj === undefined || xj === undefined) continue;
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function milesBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 3958.8;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Map-overlay payload: hail swaths only (wind tracks triple the bytes for
// little door-knocking value), trimmed to what Leaflet needs to draw them.
export type HailSwath = { rings: number[][][]; size: number | null; date: string };
export function slimHailTracks(tracks: VerifiedTrack[]): HailSwath[] {
  return tracks
    .filter((t) => t.eventType === "hail" && Array.isArray(t.rings) && t.rings.length > 0)
    .map((t) => ({ rings: t.rings!, size: t.size ?? null, date: t.date }));
}

export function parseVerifiedTracks(tracks: VerifiedTrack[], lat: number, lng: number): StormEvent[] {
  const events: StormEvent[] = [];
  for (const t of tracks) {
    if (!t?.date || (t.eventType !== "hail" && t.eventType !== "wind")) continue;
    const atPoint = (t.rings ?? []).some((r) => Array.isArray(r) && pointInRing(lat, lng, r));
    const near = atPoint || (t.center != null && milesBetween(lat, lng, t.center.lat, t.center.lng) <= STORM_NEARBY_MILES);
    if (!near) continue;
    events.push({
      date: t.date,
      eventType: t.eventType,
      size: t.size ?? undefined,
      windMph: t.windMph ?? undefined,
      atPoint,
    });
  }
  return events;
}

function summarize(events: StormEvent[]): StormSummary {
  if (events.length === 0) return EMPTY_STORMS;
  let maxHailInches = 0, maxWindMph = 0, worst: StormEvent | null = null, worstScore = -1;
  for (const e of events) {
    const hail = e.eventType === "hail" ? e.size ?? 0 : 0;
    const wind = e.eventType === "wind" ? e.windMph ?? 0 : 0;
    maxHailInches = Math.max(maxHailInches, hail);
    maxWindMph = Math.max(maxWindMph, wind);
    const score = hail * 10 + wind;
    if (score > worstScore) { worstScore = score; worst = e; }
  }
  const daysSinceWorst = worst?.date ? Math.floor((Date.now() - Date.parse(worst.date)) / 86_400_000) : null;
  return { events, eventCount: events.length, maxHailInches, maxWindMph, daysSinceWorst, worstEventId: worst?.id ?? null };
}

export function makeFakeStormProof(): StormProofGateway & { calls: { op: string }[] } {
  const calls: { op: string }[] = [];
  return {
    calls,
    async getProperty({ lat, lng }) {
      calls.push({ op: "getProperty" });
      if (lat == null || lng == null) return null;
      return { yearBuilt: 2004, roofAge: new Date().getFullYear() - 2004, roofType: null, county: "Maricopa", supported: true };
    },
    async lookupStorms() {
      calls.push({ op: "lookupStorms" });
      return summarize([{ date: "2026-05-01", eventType: "hail", size: 1.5, id: "evt_fake_1" }]);
    },
    async lookupStormTracks({ lat, lng }) {
      calls.push({ op: "lookupStormTracks" });
      if (lat == null || lng == null) return [];
      const d = 0.01;
      return [{
        rings: [[[lat - d, lng - d], [lat + d, lng - d], [lat + d, lng + d], [lat - d, lng + d]]],
        center: { lat, lng },
        eventType: "hail" as const,
        size: 1.5,
        windMph: null,
        date: "2026-05-01",
      }];
    },
    async generateCertificate({ lat, lng }: { address?: string; lat?: number; lng?: number; months?: number }) {
      calls.push({ op: "generateCertificate" });
      return {
        verified: true,
        certId: "BSS-FAKE1",
        pdfBase64: "JVBERi0xLjQK", // "%PDF-1.4" — minimal stub bytes
        verifyUrl: `https://stormproofcerts.com/verify/BSS-FAKE1?lat=${lat ?? 0}&lng=${lng ?? 0}&date=2026-06-08`,
        storm: { date: "2026-06-08", eventType: "hail" as const, size: 1.5, windMph: null },
        checkedMonths: 24,
      };
    },
  };
}

export const stormProof: StormProofGateway = process.env.STORMPROOF_API_BASE ? httpStormProof : makeFakeStormProof();
