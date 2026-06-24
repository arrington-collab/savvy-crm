export type StormEvent = { date: string; eventType: "hail" | "wind"; size?: number; windMph?: number; id?: string };
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
      const d = (await res.json()) as { events?: StormEvent[] };
      return summarize(d.events ?? []);
    } catch { return EMPTY_STORMS; }
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
