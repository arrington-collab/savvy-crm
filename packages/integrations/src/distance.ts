export type LatLng = { lat: number; lng: number };

export interface DistanceGateway {
  // Drive-time MINUTES for each origin→dest pairing, row-major [origins][dests].
  // Any unresolvable pair is null; the whole call is null on transport/quota error (fail-open).
  driveMinutesMatrix(origins: LatLng[], dests: LatLng[]): Promise<(number | null)[][] | null>;
}

function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371; // km
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Deterministic fake: 1.3× road factor over straight-line km at ~40 km/h ⇒ minutes = km * 1.95.
export function fakeDriveMinutes(a: LatLng, b: LatLng): number {
  return Math.round(haversineKm(a, b) * 1.95);
}

const SERVER_KEY = (): string => process.env.GOOGLE_MAPS_SERVER_KEY ?? "";

export const httpDistance: DistanceGateway = {
  async driveMinutesMatrix(origins, dests) {
    if (!SERVER_KEY() || origins.length === 0 || dests.length === 0) return null;
    try {
      const u = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
      u.searchParams.set("origins", origins.map((p) => `${p.lat},${p.lng}`).join("|"));
      u.searchParams.set("destinations", dests.map((p) => `${p.lat},${p.lng}`).join("|"));
      u.searchParams.set("departure_time", "now"); // duration_in_traffic when available
      u.searchParams.set("key", SERVER_KEY());
      const res = await fetch(u);
      if (!res.ok) return null;
      const data = (await res.json()) as {
        rows?: { elements?: { status?: string; duration_in_traffic?: { value: number }; duration?: { value: number } }[] }[];
      };
      const rows = data.rows ?? [];
      return origins.map((_, i) =>
        dests.map((__, j) => {
          const el = rows[i]?.elements?.[j];
          if (!el || el.status !== "OK") return null;
          const secs = el.duration_in_traffic?.value ?? el.duration?.value;
          return typeof secs === "number" ? Math.round(secs / 60) : null;
        }),
      );
    } catch {
      return null;
    }
  },
};

export function makeFakeDistance(): DistanceGateway & { calls: number } {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    async driveMinutesMatrix(origins, dests) {
      state.calls++;
      if (origins.length === 0 || dests.length === 0) return null;
      return origins.map((o) => dests.map((d) => fakeDriveMinutes(o, d)));
    },
  };
}

// Use the real provider only when a server key is configured; otherwise the fake (dev/test).
export const distance: DistanceGateway = process.env.GOOGLE_MAPS_SERVER_KEY ? httpDistance : makeFakeDistance();
